# NAS-Google-Sync

**Free up Google storage by backing up your photos to a Synology NAS.**

Google killed their Photos API in March 2025. This tool works around that by importing your photos from Google Takeout and uploading them to Synology Photos.

---

## Before You Start: Fix Your Photo Dates

Google Takeout strips metadata (dates, locations) from your photos and stores it in separate JSON files. This tool reads those JSON files, but **your photos will still have wrong dates embedded in them**.

If you want your photos to have correct dates when viewed in Synology Photos (or any other app), run **[Google Takeout Metadata Restorer](https://github.com/pfilbin90/google-takeout-metadata-restorer)** on your Takeout folder first. It embeds the dates and locations back into your actual photo files.

**Recommended workflow:**
1. Download and extract your Google Takeout
2. Run [google-takeout-metadata-restorer](https://github.com/pfilbin90/google-takeout-metadata-restorer) to fix embedded dates
3. Then use this tool (nas-google-sync) to upload to Synology

---

## What It Does

1. **Scans** your Synology NAS to see what photos you already have
2. **Imports** your Google Takeout export and detects albums and duplicates
3. **Uploads** only NEW photos to your Synology (skips duplicates)
4. **Creates albums** in Synology Photos matching your Google Photos albums
5. **Preserves dates** by reading the JSON metadata files from Google Takeout
6. **Tells you** which photos are safe to delete from Google (with date ranges)

---

## Quick Start (Single User)

### 1. Install Node.js

Download and install from **https://nodejs.org** (click the LTS version).

To verify it worked, open a terminal and type:
```
node --version
```

### 2. Download This Tool

**Option A:** Click the green "Code" button above → "Download ZIP" → Extract it

**Option B:** Or use git:
```
git clone https://github.com/pfilbin90/nas-google-sync.git
```

### 3. Install & Build

Open a terminal/command prompt in the extracted folder:
```
npm install
npm run build
```

### 4. Configure

1. Copy `.env.example` to `.env`
2. Open `.env` in a text editor and fill in your Synology details:

```env
SYNOLOGY_HOST=192.168.1.100
SYNOLOGY_PORT=5000

SYNOLOGY_USERNAME=your_synology_username
SYNOLOGY_PASSWORD=your_synology_password
SYNOLOGY_PHOTO_PATH=/homes/your_synology_username/Photos

GOOGLE_ACCOUNT=mygoogle
```

That's it! Just 6 values to fill in.

> **Note:** Your Synology user must be in the **Administrators group** (DSM 7 requirement).

### 5. Export Your Photos from Google

1. Go to [takeout.google.com](https://takeout.google.com)
2. Click "Deselect all"
3. Scroll down and check **Google Photos**
4. Click "Next step" → Create export
5. Wait for Google's email, then download and extract the ZIP file(s)

> **Tip:** If you get multiple ZIP files, extract them all into the same folder.

### 6. Run It

```bash
# Step 1: Scan your Synology to find existing photos
node dist/index.js scan

# Step 2: Import the Google Takeout
node dist/index.js import "C:\path\to\Takeout\Google Photos" --account mygoogle

# Step 3: Upload to Synology
node dist/index.js sync --account mygoogle

# Step 4: Create albums in Synology Photos
node dist/index.js fix-albums --account mygoogle

# Step 5: See what's safe to delete from Google
node dist/index.js export --format dates --account mygoogle
```

**That's it!** Your photos are backed up with all their albums preserved.

> **Note:** If your path has spaces, make sure the entire command is on one line.

---

## Multiple Users (You + Spouse)

Each person needs their own Google Takeout export and their own Synology account.

### Configure for Two Users

```env
SYNOLOGY_HOST=192.168.1.100
SYNOLOGY_PORT=5000

# User 1 (you)
SYNOLOGY_USERNAME=your_username
SYNOLOGY_PASSWORD=your_password
SYNOLOGY_PHOTO_PATH=/homes/your_username/Photos
GOOGLE_ACCOUNT=me

# User 2 (spouse)
SYNOLOGY_2_USERNAME=spouse_username
SYNOLOGY_2_PASSWORD=spouse_password
SYNOLOGY_2_PHOTO_PATH=/homes/spouse_username/Photos
GOOGLE_ACCOUNT_2=spouse
```

### Run for Each Person

**Step 1:** Each person exports from [takeout.google.com](https://takeout.google.com) and extracts to separate folders.

**Step 2:** Import and sync each account:

```bash
# Scan Synology first (only needed once)
node dist/index.js scan

# YOUR photos
node dist/index.js import "C:\Takeout\me" --account me
node dist/index.js sync --account me
node dist/index.js fix-albums --account me

# SPOUSE's photos
node dist/index.js import "C:\Takeout\spouse" --account spouse
node dist/index.js sync --account spouse
node dist/index.js fix-albums --account spouse
```

**Step 3:** See what each person can delete:

```bash
node dist/index.js export --format dates --account me
node dist/index.js export --format dates --account spouse
```

Each person deletes from their **own** Google Photos account based on their date ranges.

---

## Album Support

Your Google Photos albums are automatically preserved! Here's how:

1. **During import**, albums are detected from your Google Takeout folder structure
2. **During sync**, your photos are uploaded to Synology
3. **After sync**, run `fix-albums` to create albums in Synology Photos

```bash
# See what albums were found in your Google Takeout
node dist/index.js albums --account mygoogle

# Create albums in Synology Photos (do this after sync)
node dist/index.js fix-albums --account mygoogle
```

**The `fix-albums` command:**
- Creates albums in Synology Photos matching your Google Photos albums
- Automatically adds your uploaded photos to the correct albums
- Works with photos you've already uploaded (no re-upload needed)
- Shows progress as it works

**Example output:**
```text
========== Album Sync Status ==========
  Photos with album assignments: 1,250
  Already in Synology albums: 0
  Needing album assignment: 1,250

Processing album "Trip to Florida" (234 photos)...
Created album "Trip to Florida" (ID: 12)
Added 234 photos to album 12

Albums created: 47
Photos added to albums: 1,250
```

That's it! Your albums appear in Synology Photos immediately.

> **Tip:** For large libraries (thousands of photos), you can test first with `-n 10` to process just 10 photos.

---

## All Commands

| Command | What it does |
|---------|--------------|
| `scan` | Index existing photos on your Synology |
| `import <path> --account <name>` | Import a Google Takeout folder |
| `sync --account <name>` | Upload new photos to Synology |
| `fix-albums --account <name>` | Create albums in Synology Photos |
| `albums` | List all detected albums |
| `export --format dates --account <name>` | Show what's safe to delete from Google |

---

## Advanced Options

### Upload in Batches

For large libraries, you can upload photos in batches:

```bash
# Upload all at once (default)
node dist/index.js sync --account mygoogle

# Upload in batches of 100
node dist/index.js sync --account mygoogle -n 100

# Test with 5 photos first
node dist/index.js sync --account mygoogle -n 5

# Preview without uploading
node dist/index.js sync --account mygoogle --dry-run
```

### Process Albums in Batches

For large libraries, process albums in smaller batches:

```bash
# Process all photos with albums (default)
node dist/index.js fix-albums --account mygoogle

# Process only 100 photos (for testing)
node dist/index.js fix-albums --account mygoogle -n 100

# Preview without making changes
node dist/index.js fix-albums --account mygoogle --dry-run
```

### Debug and Verify

Check if duplicate detection is working correctly:

```bash
# Search for a specific photo
node dist/index.js inspect --search "IMG_1234.jpg"

# Show matched duplicates
node dist/index.js inspect --matched

# Show what will be uploaded as "new"
node dist/index.js inspect --new
```

---

## Deleting Photos from Google

Google doesn't let apps delete photos. After confirming your backup, use [Google Photos Toolkit](https://github.com/xob0t/Google-Photos-Toolkit) (a free browser extension) to bulk-delete by date range.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Authentication failed | Add your Synology user to the Administrators group in DSM |
| 0 new photos found | All photos already exist on Synology - that's good! |
| Albums not created | Run `scan` first, then run `fix-albums`. Photos must be uploaded and indexed before albums can be created |
| Multiple ZIP files | Extract all ZIPs into the same folder before importing |
| "Already on Synology" count is 0 | Make sure you ran `scan` before `import` |
| Wrong dates on photos | Check if the `.supplemental-metadata.json` files exist in your Takeout |

---

## How It Works

### Duplicate Detection

The tool matches photos between Google and Synology using:
- **Filename + Date** - Same filename taken on the same day
- **File hash** - Identical file content

Duplicates are skipped during upload and marked as safe to delete from Google.

### Album Detection

Albums are detected from your Google Takeout folder structure. Each subfolder under "Google Photos" becomes an album (e.g., `Trip to Florida/` → Album: "Trip to Florida").

Auto-generated folders are automatically skipped:
- `Photos from YYYY`
- Date-pattern folders like `2024-01-15`
- `Untitled`, `Archive`, `Trash`

### Scanning

The `scan` command indexes existing photos on your Synology:
- **Personal Space** - Your private photos in `/homes/<username>/Photos`
- **Shared Space** - Photos in the shared `/photo` folder

For multiple users, Shared Space photos are tracked globally (counted only once).

---

## License

MIT — free to use and modify.
