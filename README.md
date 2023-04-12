# Folderize

This script moves files into folders based on creation date. It first checks for EXIF data and uses the creation date from there if available, then falls back to the file system creation date. It allows temporary system files such as .DS_Store and Thumbs.db to be overwritten. It then removes any remaining empty folders from the source folder.

Files are moved into folders of the following format...

`{YEAR}/{YEAR-MONTH}`

`2023/2023-01`

----------

## Usage

`node folderize.js SOURCE_FOLDER DESTINATION_FOLDER`

...insert magic here...

