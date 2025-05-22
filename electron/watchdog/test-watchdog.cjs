// Simple script to test the watchdog
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

console.log("Starting watchdog test...");

// Path to watchdog script
const watchdogPath = path.join(__dirname, 'minecraft-watchdog.js');

// Check if watchdog script exists
if (!fs.existsSync(watchdogPath)) {
  console.error(`Watchdog script not found at: ${watchdogPath}`);
  process.exit(1);
}

// Current process PID
const myPid = process.pid;
console.log(`Current process PID: ${myPid}`);

// Write debug info to help the watchdog
try {
  const testIdentifier = `minecraft-core-test-${Date.now()}`;
  const debugInfoPath = path.join(__dirname, 'server-process-debug.json');
  
  // Get current running Java processes before we start
  console.log("Checking for existing Java processes before starting test...");
  try {
    const stdout = execSync('wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /format:csv', 
      { encoding: 'utf8' });
    const lines = stdout.trim().split('\n');
    if (lines.length > 1) {
      console.log(`Warning: Found ${lines.length - 1} Java processes already running before test`);
    } else {
      console.log("No Java processes running before test - good!");
    }
  } catch (e) {
    console.log("Error checking for Java processes:", e.message);
  }

  // Launch a test Java process
  console.log("Launching test Java process...");
  let javaProcess;
  try {
    // Try to use a real Java command that includes our identifier
    javaProcess = spawn('java', [
      `-Dminecraft.core.server.id=${testIdentifier}`,
      '-version'
    ], {
      detached: true,
      shell: true
    });
    
    console.log(`Test Java process started with PID: ${javaProcess.pid}`);
    console.log(`Using test identifier: ${testIdentifier}`);
    
    // Give Java process time to start
    setTimeout(() => {
      // Find the actual Java PID
      let actualJavaPid = null;
      try {
        console.log("Attempting to find actual Java PID...");
        const stdout = execSync('wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /format:csv', 
          { encoding: 'utf8' });
        
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          if (line.includes(testIdentifier)) {
            const match = line.match(/,(\d+)$/);
            if (match && match[1]) {
              actualJavaPid = parseInt(match[1], 10);
              console.log(`Found actual Java PID: ${actualJavaPid} for test process`);
              break;
            }
          }
        }
        
        if (!actualJavaPid) {
          console.log("Could not find actual Java PID");
        }
      } catch (err) {
        console.error("Error finding Java PID:", err.message);
      }
      
      // Write debug info
      fs.writeFileSync(debugInfoPath, JSON.stringify({
        nodePid: javaProcess.pid,
        javaPid: actualJavaPid,
        serverIdentifier: testIdentifier,
        timestamp: new Date().toISOString()
      }, null, 2));
      console.log(`Saved debug info to: ${debugInfoPath}`);
      
      // Start the watchdog process
      console.log("Launching watchdog process...");
      const watchdog = spawn('node', [
        watchdogPath,
        myPid.toString(),
        testIdentifier
      ], {
        detached: true,
        stdio: 'ignore'
      });
      
      // Allow the watchdog to run independently
      watchdog.unref();
      console.log(`Watchdog started with PID: ${watchdog.pid || 'unknown'}`);
      
      // After 5 seconds, simulate a crash
      console.log("Will simulate crash in 5 seconds...");
      setTimeout(() => {
        console.log("Simulating crash by exiting process...");
        process.exit(0);
      }, 5000);
    }, 1000); // Wait 1 second for Java to start
  } catch (err) {
    console.error(`Error launching test: ${err.message}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`Error setting up test: ${err.message}`);
  process.exit(1);
} 