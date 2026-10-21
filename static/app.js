const fileInput = document.getElementById('file-input');
const dropZone = document.getElementById('drop-zone');
const selectedFile = document.getElementById('selected-file');
const fileLabel = document.getElementById('file-label');
const uploadForm = document.getElementById('upload-form');

function showFile(file) {
  if (!selectedFile || !fileLabel) return;
  if (!file) {
    selectedFile.textContent = 'No file selected';
    fileLabel.textContent = 'Choose a file to upload';
    return;
  }
  selectedFile.textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(2)} MB`;
  fileLabel.textContent = file.name;
}
fileInput?.addEventListener('change', () => showFile(fileInput.files[0]));
['dragenter', 'dragover'].forEach(name => dropZone?.addEventListener(name, event => {
  event.preventDefault();
  dropZone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach(name => dropZone?.addEventListener(name, event => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
}));
dropZone?.addEventListener('drop', event => {
  const files = event.dataTransfer?.files;
  if (files?.length && fileInput) {
    fileInput.files = files;
    showFile(files[0]);
  }
});
uploadForm?.addEventListener('submit', event => {
  const file = fileInput?.files?.[0];
  if (!file) {
    event.preventDefault();
    alert('Please choose a file first.');
  } else if (file.size > 100 * 1024 * 1024) {
    event.preventDefault();
    alert('This file is larger than 100 MB. Please choose a smaller file.');
  }
});
