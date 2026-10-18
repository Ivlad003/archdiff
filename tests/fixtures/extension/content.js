// The content script: highlights what the panel asks for.
chrome.runtime.onMessage.addListener(onMessage);

function onMessage(msg) {
  if (msg.type === 'highlight') highlight(msg.text);
}

function highlight(text) {
  document.body.append(text);
}
