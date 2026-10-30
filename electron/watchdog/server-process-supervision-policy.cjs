'use strict';

const NOT_REQUIRED = Object.freeze({ available: true, reason: 'not-required' });
const POWERSHELL_READY = Object.freeze({ available: true, reason: null });
const POWERSHELL_UNAVAILABLE = Object.freeze({ available: false, reason: 'powershell-unavailable' });

let supervisionRequired = false;
let supervisionAvailability = NOT_REQUIRED;

// Called by the installed app watchdog supervisor. `available` records whether
// its Windows PowerShell runtime resolved, so a watchdog can ever arm.
function enableServerProcessSupervisionRequirement({ available = true } = {}) {
  supervisionRequired = true;
  supervisionAvailability = available === false ? POWERSHELL_UNAVAILABLE : POWERSHELL_READY;
  return true;
}

function isServerProcessSupervisionRequired() {
  return supervisionRequired;
}

// Whether a start that needs an armed watchdog can get one. Without an
// installed supervisor nothing is required, so nothing is refused.
function getSupervisionAvailability() {
  return supervisionAvailability;
}

module.exports = {
  enableServerProcessSupervisionRequirement,
  getSupervisionAvailability,
  isServerProcessSupervisionRequired
};
