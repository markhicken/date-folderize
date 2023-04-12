// see https://github.com/markhicken/folderize for more info

import {globby} from 'globby';
import ExifImage from 'node-exif';
import enquirer from 'enquirer';
import fs from 'fs';
import path from 'path';
import { utimesSync } from 'utimes';

let srcPath = process.argv[2];
let dstPath = process.argv[3];

const overwriteableFiles = ['.DS_Store', 'Thumbs.db'];

function cleanEmptyFoldersRecursively(folder, isSubFolder = false) {
  if (!fs.statSync(folder).isDirectory()) {
    return;
  }

  let files = fs.readdirSync(folder);
  if (files.length > 0) {
    files.forEach((file) => {
      const fullPath = path.join(folder, file);
      cleanEmptyFoldersRecursively(fullPath, true);
    });

    // re-evaluate files; after deleting subfolder
    // we may have parent folder empty now
    if (isSubFolder) {
      files = fs.readdirSync(folder);
    }
  }

  if (files.length === 0 && isSubFolder) {
    console.log('Removing: ', folder);
    fs.rmdirSync(folder);
    return;
  }
}

(async () => {
  if (!srcPath) {
    console.log('Please provide a source path');
    process.exit(1);
  } else {
    srcPath = srcPath[srcPath.length-1] === '/' ? srcPath : srcPath + '/';
    if (!fs.existsSync(srcPath)) {
      console.log(`Source path "${srcPath}" does not exist.`);
      process.exit(1);
    }
  }

  if (!dstPath) {
    console.log('Please provide a destination path');
    process.exit(1);
  } else {
    dstPath = dstPath[dstPath.length-1] === '/' ? dstPath : dstPath + '/';
    if (!fs.existsSync(dstPath)) {
      console.log(`Destination path "${dstPath}" does not exist.`);
      process.exit(1);
    }
  }

  const shouldContinue = await new enquirer.Confirm({
    message: `Are you sure you want to move all files from "${srcPath}" to "${dstPath}{year}/{year-month}"?`
  }).run();
  if (!shouldContinue) {
    process.exit(0);
  }

  let files;
  try {
    files = await globby([
      srcPath + '**/.*', // include hidden files
      srcPath + '**/*'
    ], {
      stats: true,
      checkCwdOption: false,
      ignore: ['**/node_modules/**']
    });
  } catch (error) {
    process.exit(error);
  }

  files = await Promise.all(files.map(async(file) => {
    return new Promise((resolve, reject) => {
      let updatedFile = {...file, exifData: null, filingDateSrc: 'file.createdAt', errorInfo: []};
      let filingCreatedDate = updatedFile.stats.birthtime;
      try {
        new ExifImage({image: file.path}, function (error, exifData) {
          if (error) {
            updatedFile.errorInfo.push(`Error parsing EXIF data for "${file.path}". Using file date instead - ` + error.message);
          } else {
            const exifCreateDate = exifData.exif.CreateDate || exifData.exif.DateTimeOriginal || exifData.exif.DateTimeDigitized || exifData.image.ModifyDate || exifData.image.CreateDate;
            updatedFile.filingCreatedDate = exifCreateDate || file.stats.birthtime;
            updatedFile.exifData = {...exifData};
            if (exifCreateDate) { updatedFile.filingDateSrc = `exif`; }
          }
          resolve({...updatedFile, filingCreatedDate});
        });
      } catch(error) {
        updatedFile.errorInfo.push(`No EXIF data for "${file}". Using file created date instead - ` + error.message);
        resolve({...updatedFile, filingCreatedDate});
      }
    });
  }));

  const filesForFiling = files.map(file => {
    const filingDate = new Date(file.filingCreatedDate);
    const month = ('0' + (filingDate.getMonth() + 1)).slice(-2);
    const dstFolder = dstPath + filingDate.getFullYear() + '/' + filingDate.getFullYear() + '-' + month + '/';
    return {
      name: file.name,
      srcFilePath: file.path,
      dstPath: dstFolder,
      dstFilePath: dstFolder + file.name,
      stats: file.stats,
    };
  });

  filesForFiling.forEach((file, index) => {
    // check if folder exists
    if(!fs.existsSync(file.dstPath)) {
      try {
        fs.mkdirSync(file.dstPath, { recursive: true });
      }
      catch(error) {
        console.log(`Error creating "${file.dstPath}" - ` + error.message);
      }
    }

    // do the move
    try {
      if(
        !fs.existsSync(file.dstFilePath) ||
        overwriteableFiles.includes(file.name)
      ) {
        // fs.renameSync only works if src and dst are on the same drive so we'll copy and unlink instead
        fs.copyFileSync(file.srcFilePath, file.dstFilePath);
        // to retain timestamps
        utimesSync(file.dstFilePath, {
          btime: file.stats.birthtimeMs || file.stats.btimeMs,
          mtime: file.stats.mtimeMs,
          atime: file.stats.atimeMs
        });
        fs.unlinkSync(file.srcFilePath);
        console.log(`(${index+1}/${filesForFiling.length}) Moved "${file.srcFilePath}" to "${file.dstFilePath}"`);
      } else {
        throw {message: 'destination already exists'};
      }
    } catch (error) {
      console.log(`(${index+1}/${filesForFiling.length}) Error moving "${file.srcFilePath}" to "${file.dstFilePath}" - ` + error.message);
    }
  });

  const shouldCleanup = await new enquirer.Confirm({
    message: `Would you like to remove empty folders from "${srcPath}"?`
  }).run();
  if (shouldCleanup) {
    cleanEmptyFoldersRecursively(srcPath);
  }
})();