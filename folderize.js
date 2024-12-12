// see https://github.com/markhicken/folderize for more info

import {globby} from 'globby';
import ExifImage from 'node-exif';
import enquirer from 'enquirer';
import fs from 'fs';
import path from 'path';
import { utimesSync } from 'utimes';

const CONTINUOUS_INTERVAL = 1000 * 60 * 60; // minutes
const LOG_FOLDER = './log';
const LOG_FILE = getLogFileName();
const overwriteableFiles = ['.DS_Store', 'Thumbs.db'];

let srcPath = process.argv[2];
let dstPath = process.argv[3];
let continuous = process.argv[4]?.toLowerCase() === 'continuous';


function getLogFileName() {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[T]/g, ' ')
    .replace(/[Z]/g, '')
    .replace(/\..+/, '')
    .replace(/:/g, '-');
  return `${LOG_FOLDER}/folderize_${timestamp}.log`;
};

async function log(message, persistToFile = true) {
  const timestamp = new Date().toISOString();
  const logEntry = `${timestamp} - ${message}\n`;
  console.log(message);
  if (persistToFile) {
    try {
      await fs.promises.appendFile(LOG_FILE, logEntry);
    } catch (error) {
      console.log('error writing to log file');
    }
  }
}

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
    log('Removing: ', folder);
    fs.rmdirSync(folder);
    return;
  }
}

function validatePath(path, pathName, shouldCreate) {
  if (!path) {
    log(`Please provide a ${pathName} path`);
    process.exit(1);
  } else {
    path = path[path.length-1] === '/' ? path : path + '/';
    if (!fs.existsSync(path)) {
      if (shouldCreate) {
        try {
          fs.mkdirSync(path, { recursive: true });
        } catch (error) {
          // this is primarily used for creating the log file path so we will
          // use the direct console.log if it fails
          console.log(`Cannot create folder: ${path}`);
          process.exit(1);
        }
      } else {
        log(`${pathName} path "${path}" does not exist.`);
        process.exit(1);
      }
    }
  }
}

async function getExtendedFile(file) {
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
};

async function moveFiles(_srcPath, _dstPath) {
  // no need to recurse because of globby
  let files;
  try {
    files = await globby([
      _srcPath + '/**/.*', // include hidden files
      _srcPath + '/**/*'
    ], {
      stats: true,
      checkCwdOption: false,
      ignore: ['**/node_modules/**']
    });
  } catch (error) {
    process.exit(error);
  }

  log('Getting files info...');
  for(let i=0; i<files.length; i++) {
    log(`Getting file info: (${i+1}/${files.length}) ${files[i].path}`, false);
    files[i] = await getExtendedFile(files[i]);
  }

  const filesForFiling = files.map(file => {
    const filingDate = new Date(file.filingCreatedDate);
    const month = ('0' + (filingDate.getMonth() + 1)).slice(-2);
    const dstFolder = `${_dstPath}/${filingDate.getFullYear()}/${filingDate.getFullYear()}-${month}/`;
    return {
      name: file.name,
      srcFilePath: file.path,
      dstPath: dstFolder,
      dstFilePath: dstFolder + file.name,
      stats: file.stats,
    };
  });

  log('Creating folders...');
  filesForFiling.forEach((file, index) => {
    // check if folder exists
    if(!fs.existsSync(file.dstPath)) {
      try {
        fs.mkdirSync(file.dstPath, { recursive: true });
      }
      catch(error) {
        log(`Error creating "${file.dstPath}" - ` + error.message);
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
          btime: Math.floor(file.stats.birthtimeMs || file.stats.btimeMs),
          mtime: Math.floor(file.stats.mtimeMs),
          atime: Math.floor(file.stats.atimeMs)
        });
        fs.unlinkSync(file.srcFilePath);
        log(`(${index+1}/${filesForFiling.length}) Moved "${file.srcFilePath}" to "${file.dstFilePath}"`);
      } else {
        throw {message: 'destination already exists'};
      }
    } catch (error) {
      log(`(${index+1}/${filesForFiling.length}) Error moving "${file.srcFilePath}" to "${file.dstFilePath}" - ` + error.message);
    }
  });
}


async function checkAndFolderize() {
  await log('Checking for files to folderize...');
  await moveFiles(srcPath, dstPath);
  if (continuous) {
    log(`Waiting ${CONTINUOUS_INTERVAL/1000/60} minutes to check for more files.`)
  }
}

(async () => {
  validatePath(LOG_FOLDER, 'log', true);
  continuous && await log('Folderize started.');
  validatePath(srcPath, 'Source');
  validatePath(dstPath, 'Destination');

  if (!continuous) {
    const shouldContinue = await new enquirer.Confirm({
      message: `Are you sure you want to move all files from "${srcPath}" to "${dstPath}{year}/{year-month}"?`
    }).run();
    if (!shouldContinue) {
      process.exit(0);
    }
  }


  // handle first run
  await checkAndFolderize();

  if (continuous) {
    // Set up periodic runs
    setInterval(async() => {
      await checkAndFolderize();
    }, CONTINUOUS_INTERVAL);
  } else {
    // offer to clean up after single runs
    const shouldCleanup = await new enquirer.Confirm({
      message: `Would you like to remove empty folders from "${srcPath}"?`
    }).run();
    if (shouldCleanup) {
      cleanEmptyFoldersRecursively(srcPath);
    }
  }
})();
