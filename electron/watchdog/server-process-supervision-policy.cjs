'use strict';

let supervisionRequired = false;

function enableServerProcessSupervisionRequirement() {
  supervisionRequired = true;
  return true;
}

function isServerProcessSupervisionRequired() {
  return supervisionRequired;
}

module.exports = {
  enableServerProcessSupervisionRequirement,
  isServerProcessSupervisionRequired
};
