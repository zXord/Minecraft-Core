/**
 * Helper functions for handling files in the Electron environment
 */
import logger from './logger.js';

/**
 * Converts a File object to a path using a FileReader
 * This creates a temporary copy of the file that can be used by Electron.
 * 
 * @param {File} file - Browser File object
 * @returns {Promise<string>} Path to the temporary file
 */
export function fileToPath(file) {
  logger.info('Converting file to path', {
    category: 'utils',
    data: {
      function: 'fileToPath',
      fileName: file?.name,
      fileSize: file?.size,
      fileType: file?.type,
      isValidFile: file instanceof File
    }
  });
  
  if (!file || !(file instanceof File)) {
    logger.error('Invalid file object provided to fileToPath', {
      category: 'utils',
      data: {
        function: 'fileToPath',
        file,
        isFile: file instanceof File
      }
    });
    return Promise.reject(new Error('Invalid file object provided'));
  }
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = async (event) => {
      try {
        // Convert the file to an ArrayBuffer
        // @ts-ignore - In a JS file we know this is an ArrayBuffer because we used readAsArrayBuffer
        const arrayBuffer = event.target.result;
        
        // Ensure arrayBuffer is checked for its type before accessing byteLength
        if (!(arrayBuffer instanceof ArrayBuffer)) {
          const errorMsg = `Unexpected type for arrayBuffer: ${typeof arrayBuffer}`;
          logger.error('Invalid arrayBuffer type in fileToPath', {
            category: 'utils',
            data: {
              function: 'fileToPath',
              fileName: file.name,
              resultType: typeof arrayBuffer,
              expected: 'ArrayBuffer'
            }
          });
          reject(new Error(errorMsg));
          return;
        }
        
        logger.debug('File read successfully, saving to temp file', {
          category: 'utils',
          data: {
            function: 'fileToPath',
            fileName: file.name,
            arrayBufferSize: arrayBuffer.byteLength
          }
        });
        
        // Use Electron to save this to a temporary file and return the path
        const tempPath = await window.electron.invoke('save-temp-file', {
          name: file.name,
          // @ts-ignore - We know this is an ArrayBuffer in runtime
          buffer: Array.from(new Uint8Array(arrayBuffer))
        });
        
        logger.info('File converted to temporary path successfully', {
          category: 'utils',
          data: {
            function: 'fileToPath',
            fileName: file.name,
            tempPath,
            fileSize: arrayBuffer.byteLength
          }
        });
        
        resolve(tempPath);
      } catch (err) {
        logger.error('Error in fileToPath onload handler', {
          category: 'utils',
          data: {
            function: 'fileToPath',
            fileName: file.name,
            errorMessage: err.message
          }
        });
        reject(err);
      }
    };
    
    reader.onerror = (error) => {
      logger.error('FileReader error in fileToPath', {
        category: 'utils',
        data: {
          function: 'fileToPath',
          fileName: file.name,
          error: error.toString()
        }
      });
      reject(new Error(`Failed to read file: ${error}`));
    };
    
    // Read the file as an ArrayBuffer
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Convert multiple File objects to paths
 * 
 * @param {File[]} files - Array of File objects
 * @returns {Promise<string[]>} Array of file paths
 */
export async function filesToPaths(files) {
  logger.info('Converting multiple files to paths', {
    category: 'utils',
    data: {
      function: 'filesToPaths',
      filesCount: files ? files.length : 0,
      isArray: Array.isArray(files)
    }
  });
  
  if (!files || !Array.isArray(files) || files.length === 0) {
    logger.debug('No valid files provided to filesToPaths', {
      category: 'utils',
      data: {
        function: 'filesToPaths',
        files,
        isArray: Array.isArray(files),
        length: files?.length
      }
    });
    return [];
  }
  
  const paths = [];
  let successCount = 0;
  let errorCount = 0;
  
  for (const file of files) {
    try {
      if (file && typeof file === 'object' && file.constructor && file.constructor.name === 'File') {
        const path = await fileToPath(file);
        paths.push(path);
        successCount++;
      } else {
        logger.warn('Non-File object in files array', {
          category: 'utils',
          data: {
            function: 'filesToPaths',
            file,
            type: typeof file,
            isFile: file && typeof file === 'object' && file.constructor && file.constructor.name === 'File'
          }
        });
      }
    } catch (err) {
      errorCount++;
      logger.error('Failed to convert file to path', {
        category: 'utils',
        data: {
          function: 'filesToPaths',
          fileName: file?.name,
          errorMessage: err.message
        }
      });
      // Continue with other files
    }
  }
  
  logger.info('Files to paths conversion completed', {
    category: 'utils',
    data: {
      function: 'filesToPaths',
      totalFiles: files.length,
      successCount,
      errorCount,
      pathsReturned: paths.length
    }
  });
  
  return paths;
}
