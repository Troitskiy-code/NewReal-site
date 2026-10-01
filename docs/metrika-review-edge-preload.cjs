// Reuse Cursor's browser suite with an already installed Microsoft Edge.
// Does not alter application code or test assertions.
const playwright = require('playwright');
const originalLaunch = playwright.chromium.launch.bind(playwright.chromium);
playwright.chromium.launch = options => originalLaunch({...options, channel:'msedge'});
// The original suite pipes server output without consuming it. Prevent a
// full pipe from blocking the local dev server in this environment.
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  if (command === 'npx' && args?.[0] === 'next' && args?.[1] === 'dev') {
    return originalSpawn(command, args, {...options, stdio:'ignore'});
  }
  return originalSpawn(command, args, options);
};
