/**
 * Helper functions for handling files in the Electron environment
 */

/**
 * Converts a File object to a path using a FileReader
 * This creates a temporary copy of the file that can be used by Electron.
 * 
 * @param {File} file - Browser File object
 * @returns {Promise<string>} Path to the temporary file
 */
export function fileToPath(file) {
  if (!file || !(file instanceof File)) {
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
          reject(new Error(`Unexpected type for arrayBuffer: ${typeof arrayBuffer}`));
          return;
        }
        
        // Use Electron to save this to a temporary file and return the path
        const tempPath = await window.electron.invoke('save-temp-file', {
          name: file.name,
          // @ts-ignore - We know this is an ArrayBuffer in runtime
          buffer: Array.from(new Uint8Array(arrayBuffer))
        });
        
        resolve(tempPath);
      } catch (err) {
        reject(err);
      }
    };
    
    reader.onerror = (error) => {
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
  if (!files || !Array.isArray(files) || files.length === 0) {
    return [];
  }
  
  const paths = [];
  
  for (const file of files) {
    try {
      if (file instanceof File) {
        const path = await fileToPath(file);
        paths.push(path);
      }
    } catch (err) {
      // Continue with other files
    }
  }
  
  return paths;
}
