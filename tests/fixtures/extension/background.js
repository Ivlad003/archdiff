// The service worker: the panel connects over a port, the action opens the panel.
chrome.runtime.onConnect.addListener(onConnect);
chrome.action.onClicked.addListener(openPanel);

function onConnect(port) {
  port.onMessage.addListener((msg) => fromPanel(msg, port));
}

async function fromPanel(msg, port) {
  if (msg.type === 'ping') port.postMessage({ type: 'pong', at: Date.now() });
  if (msg.type === 'highlight') await chrome.tabs.sendMessage(msg.tabId, { type: 'highlight', text: msg.text });
}

function openPanel(tab) {
  chrome.sidePanel.open({ tabId: tab.id });
}
