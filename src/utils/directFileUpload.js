/**
 * Provides direct file upload capabilities for the Electron app
 */

/**
 * Directly uploads dropped files to the server's mods directory
 * 
 * @param {FileList|File[]} files - The files from the drop event
 * @param {string} serverPath - Path to the server directory
 * @returns {Promise<{success: boolean, count: number, failed: string[]}>} Result of the upload
 */
export async function uploadDroppedMods(files, serverPath) {
  if (!files || files.length === 0) {
    return { success: false, count: 0, failed: [] };
  }
  
  if (!serverPath) {
    return { success: false, count: 0, failed: Array.from(files).map(f => f.name) };
  }
  
  const fileArray = Array.from(files);
  
  const jarFiles = fileArray.filter(file => file.name.endsWith('.jar'));
  if (jarFiles.length === 0) {
    return { success: false, count: 0, failed: fileArray.map(f => f.name) };
  }
  
  // Results tracking
  const results = {
    success: false,
    count: 0,
    failed: []
  };
  
  // Process each JAR file
  for (const file of jarFiles) {
    try {
      // Read file as ArrayBuffer
      const arrayBuffer = await readFileAsArrayBuffer(file);
      
      // Send to Electron for direct saving to the mods folder
      const success = await window.electron.invoke('direct-add-mod', {
        serverPath,
        fileName: file.name,
        buffer: Array.from(new Uint8Array(arrayBuffer))
      });
      
      if (success) {      results.count++;
      } else {
        results.failed.push(file.name);
      }
    } catch {
      results.failed.push(file.name);
    }
  }
  
  results.success = results.count > 0;
  
  return results;
}

/**
 * Reads a file as ArrayBuffer
 * 
 * @param {File} file - The file to read
 * @returns {Promise<ArrayBuffer>} File contents as ArrayBuffer
 */
function readFileAsArrayBuffer(file) {
  if (!file || !(file instanceof File)) {
    return Promise.reject(new Error('Invalid file object provided'));
  }
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => {
      // @ts-ignore - We know this is an ArrayBuffer because we used readAsArrayBuffer
      resolve(event.target.result);
    };
    
    reader.onerror = () => {
      reject(new Error(`Failed to read file: ${file.name}`));
    };
    
    reader.readAsArrayBuffer(file);
  });
}
