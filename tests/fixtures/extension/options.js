// A page the manifest does not name, opened by the extension itself.
chrome.storage.onChanged.addListener(onChanged);

function onChanged(changes) {
  document.body.textContent = Object.keys(changes).join(', ');
}
