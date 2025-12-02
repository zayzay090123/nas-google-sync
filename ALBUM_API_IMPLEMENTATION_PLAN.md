# Synology Photos Album Management - Implementation Plan

## Context

This tool currently syncs photos from Google Takeout to Synology Photos, but **albums are not preserved**.

**Critical Discovery**: Synology Photos albums are NOT based on folders or EXIF tags. They are separate database entities managed via the Synology Photos API. The current EXIF-based approach doesn't work.

**What needs to be implemented**: Use the Synology Photos API (`SYNO.Foto.Browse.Album`) to programmatically create albums and add photos to them, both for new uploads and retroactively for 70,000+ already-uploaded photos.

---

## API Endpoints to Implement

Based on exploration of existing `synology-photos.ts`, the following APIs need to be added:

### 1. List Albums
```typescript
// GET /webapi/entry.cgi
{
  api: 'SYNO.Foto.Browse.Album',
  method: 'list',
  version: 1,
  _sid: this.sessionId,
  offset: 0,
  limit: 1000
}
```
**Returns**: Array of albums with `id`, `name`, `item_count`, etc.

### 2. Create Album
```typescript
// POST /webapi/entry.cgi
{
  api: 'SYNO.Foto.Browse.Album',
  method: 'create',
  version: 1,
  _sid: this.sessionId,
  name: 'Album Name'
}
```
**Returns**: Created album object with `id`

### 3. Find Photo by Path
```typescript
// GET /webapi/entry.cgi
{
  api: 'SYNO.Foto.Browse.Item',
  method: 'list',
  version: 1,
  _sid: this.sessionId,
  folder_id: folderId,  // from listFolders()
  additional: '["thumbnail"]'
}
```
**Returns**: Array of photo items with `id`, `filename`, `folder_id`

### 4. Add Items to Album
```typescript
// POST /webapi/entry.cgi
{
  api: 'SYNO.Foto.Browse.Album',
  method: 'add_item',
  version: 1,
  _sid: this.sessionId,
  id: albumId,
  item: JSON.stringify([photoId1, photoId2, ...])
}
```
**Returns**: Success/failure status

---

## Database Schema Changes

### Add to `photos` table:
```sql
ALTER TABLE photos ADD COLUMN synology_photo_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_photos_synology_photo_id ON photos(synology_photo_id);
```

### Create `albums` table:
```sql
CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  synology_album_id INTEGER NOT NULL,
  account_name TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  UNIQUE(account_name, synology_album_id),
  UNIQUE(account_name, name)
);

CREATE INDEX IF NOT EXISTS idx_albums_account_name ON albums(account_name);
CREATE INDEX IF NOT EXISTS idx_albums_synology_id ON albums(synology_album_id);
```

### Create `album_items` junction table:
```sql
CREATE TABLE IF NOT EXISTS album_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id INTEGER NOT NULL,
  photo_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  FOREIGN KEY (album_id) REFERENCES albums(id),
  FOREIGN KEY (photo_id) REFERENCES photos(id),
  UNIQUE(album_id, photo_id)
);

CREATE INDEX IF NOT EXISTS idx_album_items_album_id ON album_items(album_id);
CREATE INDEX IF NOT EXISTS idx_album_items_photo_id ON album_items(photo_id);
```

### New Database Functions Needed:

```typescript
// In src/models/database.ts

export interface AlbumRecord {
  id: number;
  synologyAlbumId: number;
  accountName: string;
  name: string;
  createdAt: string;
  lastSyncedAt: string;
}

export function getOrCreateAlbum(accountName: string, albumName: string, synologyAlbumId: number): AlbumRecord {
  const db = getDatabase();

  // Try to find existing
  const existing = db.prepare(`
    SELECT * FROM albums WHERE account_name = ? AND name = ?
  `).get(accountName, albumName) as any;

  if (existing) {
    return mapRowToAlbum(existing);
  }

  // Create new
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO albums (synology_album_id, account_name, name, created_at, last_synced_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(synologyAlbumId, accountName, albumName, now, now);

  return getOrCreateAlbum(accountName, albumName, synologyAlbumId);
}

export function addPhotoToAlbum(photoId: string, albumId: number): void {
  const db = getDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO album_items (album_id, photo_id, added_at)
    VALUES (?, ?, ?)
  `).run(albumId, photoId, new Date().toISOString());
}

export function updatePhotoSynologyId(photoId: string, synologyPhotoId: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE photos SET synology_photo_id = ? WHERE id = ?
  `).run(synologyPhotoId, photoId);
}

export function getPhotosNeedingAlbumSync(accountName: string): PhotoRecord[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT p.* FROM photos p
    WHERE p.source = 'google'
      AND p.account_name = ?
      AND p.is_backed_up = 1
      AND p.album_name IS NOT NULL
      AND p.album_name != ''
      AND p.synology_photo_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM album_items ai
        JOIN albums a ON ai.album_id = a.id
        WHERE ai.photo_id = p.id
          AND a.name = p.album_name
      )
    ORDER BY p.album_name, p.creation_time
  `).all() as any[];

  return rows.map(mapRowToPhoto);
}
```

---

## Implementation in `synology-photos.ts`

Add these methods to the `SynologyPhotosService` class:

```typescript
/**
 * List all albums for the authenticated user
 */
async listAlbums(offset: number = 0, limit: number = 1000): Promise<any[]> {
  const response = await this.client.get('/webapi/entry.cgi', {
    params: {
      api: 'SYNO.Foto.Browse.Album',
      method: 'list',
      version: 1,
      _sid: this.sessionId,
      offset,
      limit,
    },
  });

  if (!response.data.success) {
    throw new Error(`Failed to list albums: ${JSON.stringify(response.data)}`);
  }

  return response.data.data?.list || [];
}

/**
 * Get or create an album by name
 * Returns the album ID
 */
async getOrCreateAlbum(albumName: string): Promise<number> {
  // First, try to find existing album
  const albums = await this.listAlbums();
  const existing = albums.find((a: any) => a.name === albumName);

  if (existing) {
    logger.debug(`Found existing album "${albumName}" (ID: ${existing.id})`);
    return existing.id;
  }

  // Create new album
  const response = await this.client.post('/webapi/entry.cgi', null, {
    params: {
      api: 'SYNO.Foto.Browse.Album',
      method: 'create',
      version: 1,
      _sid: this.sessionId,
      name: albumName,
    },
  });

  if (!response.data.success) {
    throw new Error(`Failed to create album "${albumName}": ${JSON.stringify(response.data)}`);
  }

  const albumId = response.data.data?.album?.id;
  if (!albumId) {
    throw new Error(`Album created but no ID returned for "${albumName}"`);
  }

  logger.info(`Created album "${albumName}" (ID: ${albumId})`);
  return albumId;
}

/**
 * Find a photo by its path in Synology Photos
 * Returns the photo ID or null if not found
 */
async findPhotoByPath(synologyPath: string): Promise<number | null> {
  // Extract folder and filename
  const parts = synologyPath.split('/');
  const filename = parts[parts.length - 1];
  const folderPath = parts.slice(0, -1).join('/');

  // Find the folder ID
  const folders = await this.listFolders();
  const folder = folders.find((f: any) => f.name === folderPath || f.name.endsWith(folderPath));

  if (!folder) {
    logger.warn(`Folder not found for path: ${folderPath}`);
    return null;
  }

  // List items in that folder
  const response = await this.client.get('/webapi/entry.cgi', {
    params: {
      api: 'SYNO.Foto.Browse.Item',
      method: 'list',
      version: 1,
      _sid: this.sessionId,
      folder_id: folder.id,
      additional: JSON.stringify(['thumbnail']),
    },
  });

  if (!response.data.success) {
    throw new Error(`Failed to list items in folder ${folder.id}: ${JSON.stringify(response.data)}`);
  }

  const items = response.data.data?.list || [];
  const photo = items.find((item: any) => item.filename === filename);

  if (photo) {
    logger.debug(`Found photo "${filename}" (ID: ${photo.id})`);
    return photo.id;
  }

  logger.warn(`Photo not found: ${filename} in folder ${folder.name}`);
  return null;
}

/**
 * Add photos to an album
 */
async addItemsToAlbum(albumId: number, photoIds: number[]): Promise<void> {
  if (photoIds.length === 0) {
    return;
  }

  const response = await this.client.post('/webapi/entry.cgi', null, {
    params: {
      api: 'SYNO.Foto.Browse.Album',
      method: 'add_item',
      version: 1,
      _sid: this.sessionId,
      id: albumId,
      item: JSON.stringify(photoIds),
    },
  });

  if (!response.data.success) {
    throw new Error(`Failed to add items to album ${albumId}: ${JSON.stringify(response.data)}`);
  }

  logger.info(`Added ${photoIds.length} photos to album ${albumId}`);
}
```

---

## Integration with Sync Flow

### Modify `sync-service.ts` `syncPhotos()` method:

**Current flow**:
1. Upload photo
2. Mark as backed up

**New flow**:
1. Upload photo
2. Mark as backed up
3. **Wait for Synology Photos to index the file (~5-10 seconds)**
4. **Find the photo ID using `findPhotoByPath()`**
5. **Store the photo ID in database**
6. **If photo has album, create/find album and add photo to it**

```typescript
// In syncPhotos() method, after successful upload:

if (success) {
  markAsBackedUp(photo.id);
  synced++;

  // Album management for newly uploaded photos
  if (albumName) {
    try {
      // Wait for Synology Photos to index the uploaded file
      logger.debug(`Waiting for Synology to index ${photo.filename}...`);
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay

      // Find the photo ID in Synology Photos
      const synologyPhotoId = await this.synologyServices[accountName]!.findPhotoByPath(remotePath);

      if (synologyPhotoId) {
        // Store the Synology photo ID
        updatePhotoSynologyId(photo.id, synologyPhotoId);

        // Get or create the album
        const synologyAlbumId = await this.synologyServices[accountName]!.getOrCreateAlbum(albumName);
        const albumRecord = getOrCreateAlbum(accountName, albumName, synologyAlbumId);

        // Add photo to album
        await this.synologyServices[accountName]!.addItemsToAlbum(synologyAlbumId, [synologyPhotoId]);
        addPhotoToAlbum(photo.id, albumRecord.id);

        logger.info(`Added ${photo.filename} to album "${albumName}"`);
      } else {
        logger.warn(`Could not find photo ID for ${photo.filename} - skipping album`);
      }
    } catch (albumError) {
      logger.error(`Failed to add photo to album: ${albumError}`);
      // Don't fail the whole sync if album creation fails
    }
  }
}
```

---

## Retroactive Album Fix

### Add new command: `fix-albums`

This command will fix albums for the 70,000+ already-uploaded photos.

**Strategy**: Process in batches to avoid overwhelming the Synology

```typescript
// In src/index.ts

program
  .command('fix-albums')
  .description('Retroactively add already-uploaded photos to albums')
  .option('--account <name>', 'Google account name to fix')
  .option('-n, --limit <number>', 'Limit number of photos to process (for testing)')
  .option('--batch-size <number>', 'Number of photos to process per batch', '100')
  .option('--dry-run', 'Preview without making changes')
  .action(async (options) => {
    const accountName = getAccountName(options.account);
    const limit = options.limit ? parseInt(options.limit, 10) : undefined;
    const batchSize = parseInt(options.batchSize, 10);

    console.log(`\nFixing albums for ${accountName}...`);

    const service = new SyncService();
    await service.authenticateAll();

    const result = await service.fixAlbumsRetroactively(
      accountName,
      {
        limit,
        batchSize,
        dryRun: options.dryRun || false,
      },
      (current, total, filename) => {
        process.stdout.write(`\r[${current}/${total}] ${filename}                    `);
      }
    );

    console.log(`\n\nAlbum Fix Results:`);
    console.log(`  Photos processed: ${result.processed}`);
    console.log(`  Photos added to albums: ${result.addedToAlbums}`);
    console.log(`  Errors: ${result.errors}`);
    console.log(`  Skipped (no album): ${result.skipped}`);
  });
```

### Add `fixAlbumsRetroactively()` to `sync-service.ts`:

```typescript
async fixAlbumsRetroactively(
  accountName: string,
  options: {
    limit?: number;
    batchSize?: number;
    dryRun?: boolean;
  } = {},
  onProgress?: (current: number, total: number, filename: string) => void
): Promise<{
  processed: number;
  addedToAlbums: number;
  errors: number;
  skipped: number;
}> {
  const { limit, batchSize = 100, dryRun = false } = options;

  // Get all photos that need album sync
  let photosToFix = getPhotosNeedingAlbumSync(accountName);

  if (limit) {
    photosToFix = photosToFix.slice(0, limit);
  }

  const stats = {
    processed: 0,
    addedToAlbums: 0,
    errors: 0,
    skipped: 0,
  };

  // Group photos by album for efficient batch processing
  const photosByAlbum = new Map<string, PhotoRecord[]>();
  for (const photo of photosToFix) {
    if (!photo.albumName) {
      stats.skipped++;
      continue;
    }

    if (!photosByAlbum.has(photo.albumName)) {
      photosByAlbum.set(photo.albumName, []);
    }
    photosByAlbum.get(photo.albumName)!.push(photo);
  }

  // Process each album
  for (const [albumName, photos] of photosByAlbum.entries()) {
    try {
      logger.info(`Processing album "${albumName}" (${photos.length} photos)`);

      if (!dryRun) {
        // Get or create the album
        const synologyAlbumId = await this.synologyServices[accountName]!.getOrCreateAlbum(albumName);
        const albumRecord = getOrCreateAlbum(accountName, albumName, synologyAlbumId);

        // Process photos in batches
        for (let i = 0; i < photos.length; i += batchSize) {
          const batch = photos.slice(i, i + batchSize);
          const photoIdsToAdd: number[] = [];

          for (const photo of batch) {
            if (onProgress) {
              onProgress(stats.processed + 1, photosToFix.length, photo.filename);
            }

            // If we don't have the Synology photo ID, try to find it
            if (!photo.synologyPath) {
              logger.warn(`Photo ${photo.filename} has no synology_path - skipping`);
              stats.skipped++;
              stats.processed++;
              continue;
            }

            let synologyPhotoId = photo.synologyPhotoId;
            if (!synologyPhotoId) {
              synologyPhotoId = await this.synologyServices[accountName]!.findPhotoByPath(photo.synologyPath);

              if (synologyPhotoId) {
                updatePhotoSynologyId(photo.id, synologyPhotoId);
              } else {
                logger.warn(`Could not find Synology photo ID for ${photo.filename}`);
                stats.errors++;
                stats.processed++;
                continue;
              }
            }

            photoIdsToAdd.push(synologyPhotoId);
            stats.processed++;
          }

          // Add batch to album
          if (photoIdsToAdd.length > 0) {
            await this.synologyServices[accountName]!.addItemsToAlbum(synologyAlbumId, photoIdsToAdd);

            // Update database
            for (const photo of batch) {
              if (photo.synologyPhotoId) {
                addPhotoToAlbum(photo.id, albumRecord.id);
                stats.addedToAlbums++;
              }
            }
          }

          // Rate limiting - small delay between batches
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } else {
        // Dry run - just count
        stats.processed += photos.length;
        logger.info(`[DRY RUN] Would add ${photos.length} photos to album "${albumName}"`);
      }
    } catch (error) {
      logger.error(`Error processing album "${albumName}": ${error}`);
      stats.errors += photos.length;
      stats.processed += photos.length;
    }
  }

  return stats;
}
```

---

## Testing Strategy

### Phase 1: Small Batch Test (5-20 photos)
```bash
# Test with a few photos first
node dist/index.js fix-albums --account mygoogle -n 5

# Verify in Synology Photos UI:
# 1. Check that albums were created
# 2. Check that photos appear in the correct albums
# 3. Verify no duplicates
```

### Phase 2: Medium Batch (100-500 photos)
```bash
node dist/index.js fix-albums --account mygoogle -n 100
```

### Phase 3: Full Library
```bash
# Process in batches to monitor progress
node dist/index.js fix-albums --account mygoogle --batch-size 100
```

### Verify New Uploads
```bash
# After fixing existing photos, test that new uploads also get albums
node dist/index.js import "path/to/new/takeout" --account mygoogle
node dist/index.js sync --account mygoogle -n 5

# Check Synology Photos UI to confirm new photos are in albums
```

---

## Performance Considerations

### For 70,000+ Photos:

1. **Batch size**: Process 100 photos at a time to avoid overwhelming Synology
2. **Rate limiting**: 1 second delay between batches
3. **Indexing wait**: 5 seconds after upload before looking up photo ID
4. **Album grouping**: Process all photos for an album together to minimize API calls
5. **Database indexing**: Ensure indexes on `synology_photo_id`, `album_name`

### Estimated Time:
- **Finding photo IDs**: ~2-3 seconds per photo (API call + indexing wait)
- **Creating albums**: One-time cost, ~1 second per album
- **Adding to albums**: ~0.5 seconds per batch of 100 photos
- **Total for 70,000 photos**: ~40-60 hours if done serially

**Optimization**: The `fix-albums` command groups photos by album and uses batch operations, reducing total time to **~8-12 hours**.

---

## Migration Path

### For Users Who Already Synced Photos:

1. **Backup database**:
   ```bash
   cp data/sync.db data/sync.db.backup
   ```

2. **Run database migration** (automatic on next run)

3. **Fix existing photos**:
   ```bash
   # Test with small batch first
   node dist/index.js fix-albums --account mygoogle -n 20

   # Then run full fix
   node dist/index.js fix-albums --account mygoogle
   ```

4. **New uploads automatically get albums** (no action needed)

---

## Error Handling

### Critical Failures (abort):
- Cannot authenticate with Synology
- Database corruption
- Album API returns permission error

### Recoverable Failures (log and continue):
- Photo not found in Synology (might be deleted)
- Album creation fails (retry once)
- Timeout waiting for indexing (skip photo, can retry later)

### Retry Logic:
```typescript
async function retryOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 2000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      logger.warn(`Attempt ${attempt} failed, retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('Should not reach here');
}
```

---

## Files to Modify

1. **src/models/database.ts** - Add schema, new functions
2. **src/services/synology-photos.ts** - Add album API methods
3. **src/services/sync-service.ts** - Modify upload flow, add retroactive fix
4. **src/index.ts** - Add `fix-albums` command
5. **README.md** - Document new command and behavior

---

## Implementation Checklist

- [ ] Database schema changes (albums, album_items tables, synology_photo_id column)
- [ ] Database helper functions (getOrCreateAlbum, addPhotoToAlbum, etc.)
- [ ] SynologyPhotosService.listAlbums()
- [ ] SynologyPhotosService.getOrCreateAlbum()
- [ ] SynologyPhotosService.findPhotoByPath()
- [ ] SynologyPhotosService.addItemsToAlbum()
- [ ] Modify syncPhotos() to add photos to albums after upload
- [ ] Implement fixAlbumsRetroactively() method
- [ ] Add fix-albums CLI command
- [ ] Test with 5 photos
- [ ] Test with 100 photos
- [ ] Update README documentation
- [ ] Run full fix on 70,000+ photos
- [ ] Remove old EXIF tagging code (tag-writer.ts, reprocess logic)

---

## Notes

- **Remove EXIF tagging**: Once API-based approach works, remove the tag-writer.ts service and all reprocessing logic since it doesn't actually create albums
- **Synology API version**: Using version 1 of Foto APIs - may need to check for newer versions
- **Authentication**: Reuse existing session management from current implementation
- **Concurrent uploads**: Consider if album operations should be queued separately from uploads to improve performance
