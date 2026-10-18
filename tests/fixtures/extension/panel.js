// The side panel: talks to the service worker over a port.
const port = chrome.runtime.connect({ name: 'panel' });
port.onMessage.addListener(onMessage);
port.postMessage({ type: 'ping' });

function onMessage(msg) {
  if (msg.type === 'pong') show(msg.at);
}

function show(at) {
  document.body.textContent = String(at);
}
