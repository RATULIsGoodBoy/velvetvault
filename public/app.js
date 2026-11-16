(() => {
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token') || '';

  // Elements
  const countdownText = document.getElementById('countdownText');
  const cameraInput = document.getElementById('cameraInput');
  const libraryInput = document.getElementById('libraryInput');
  const queueSection = document.getElementById('queueSection');
  const queueCount = document.getElementById('queueCount');
  const previewGrid = document.getElementById('previewGrid');
  const blurToggleBtn = document.getElementById('blurToggleBtn');
  const blurIcon = document.getElementById('blurIcon');
  const blurText = document.getElementById('blurText');
  const noteInput = document.getElementById('noteInput');
  const sendBtn = document.getElementById('sendBtn');
  const sendBtnText = document.getElementById('sendBtnText');
  const progressContainer = document.getElementById('progressContainer');
  const progressFill = document.getElementById('progressFill');
  const progressStatus = document.getElementById('progressStatus');
  const successCard = document.getElementById('successCard');
  const successMessage = document.getElementById('successMessage');
  const uploadMoreBtn = document.getElementById('uploadMoreBtn');
  const lockVaultBtn = document.getElementById('lockVaultBtn');
  const lockedOverlay = document.getElementById('lockedOverlay');
  const lockReason = document.getElementById('lockReason');

  let selectedFiles = [];
  let isBlurred = true;
  let remainingSeconds = 0;

  // Format seconds to mm:ss
  function formatTime(sec) {
    if (sec <= 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // Format bytes
  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // Lock out view
  function lockOut(reason = 'This session has expired. The direct connection has been shut down.') {
    lockReason.textContent = reason;
    lockedOverlay.classList.remove('hidden');
    // Clear preview memory
    for (const item of selectedFiles) {
      if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
    }
    selectedFiles = [];
    previewGrid.innerHTML = '';
  }

  // Connect SSE for live timer and session events
  function connectSSE() {
    if (!token) {
      lockOut('Missing security token.');
      return;
    }

    const eventSource = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);

    eventSource.addEventListener('tick', (e) => {
      try {
        const data = JSON.parse(e.data);
        remainingSeconds = data.remainingSeconds;
        countdownText.textContent = formatTime(remainingSeconds);
        if (remainingSeconds <= 0) {
          lockOut('Time is up! This session has expired.');
          eventSource.close();
        }
      } catch (_) {}
    });

    eventSource.addEventListener('session-expired', () => {
      lockOut('Session has closed. Thank you!');
      eventSource.close();
    });

    eventSource.addEventListener('session-locked', () => {
      lockOut('Vault has been sealed. Connection closed.');
      eventSource.close();
    });

    eventSource.onerror = () => {
      // Re-verify session validity if disconnected
      fetch(`/api/session?token=${encodeURIComponent(token)}`)
        .then(res => res.json())
        .then(data => {
          if (!data.valid) {
            lockOut('Session expired or host offline.');
            eventSource.close();
          }
        })
        .catch(() => {
          lockOut('Host computer disconnected.');
          eventSource.close();
        });
    };
  }

  // Initial fetch of session state
  fetch(`/api/session?token=${encodeURIComponent(token)}`)
    .then(r => r.json())
    .then(data => {
      if (!data.valid) {
        lockOut('Session expired or invalid.');
        return;
      }
      remainingSeconds = data.remainingSeconds;
      countdownText.textContent = formatTime(remainingSeconds);
      connectSSE();
    })
    .catch(() => lockOut('Could not connect to host.'));

  // File selection handlers
  function addFiles(fileList) {
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const isVideo = file.type.startsWith('video/');
      const objectUrl = URL.createObjectURL(file);
      selectedFiles.push({
        id: Math.random().toString(36).slice(2, 9),
        file,
        isVideo,
        objectUrl
      });
    }
    renderQueue();
  }

  cameraInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) {
      addFiles(e.target.files);
      e.target.value = '';
    }
  });

  libraryInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) {
      addFiles(e.target.files);
      e.target.value = '';
    }
  });

  // Render preview grid
  function renderQueue() {
    previewGrid.innerHTML = '';
    if (selectedFiles.length === 0) {
      queueSection.classList.add('hidden');
      return;
    }

    queueSection.classList.remove('hidden');
    successCard.classList.add('hidden');
    queueCount.textContent = selectedFiles.length;

    selectedFiles.forEach((item, index) => {
      const div = document.createElement('div');
      div.className = `preview-item ${isBlurred ? 'blurred' : ''}`;

      if (item.isVideo) {
        const video = document.createElement('video');
        video.className = 'preview-thumb';
        video.src = item.objectUrl;
        video.muted = true;
        div.appendChild(video);
      } else {
        const img = document.createElement('img');
        img.className = 'preview-thumb';
        img.src = item.objectUrl;
        img.alt = 'preview';
        div.appendChild(img);
      }

      // Tap to toggle blur on single item
      div.addEventListener('click', (e) => {
        if (e.target.closest('.preview-remove-btn')) return;
        div.classList.toggle('blurred');
      });

      // Remove button
      const removeBtn = document.createElement('button');
      removeBtn.className = 'preview-remove-btn';
      removeBtn.innerHTML = '✕';
      removeBtn.title = 'Remove';
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        URL.revokeObjectURL(item.objectUrl);
        selectedFiles.splice(index, 1);
        renderQueue();
      };
      div.appendChild(removeBtn);

      // Size tag
      const sizeTag = document.createElement('span');
      sizeTag.className = 'preview-size-tag';
      sizeTag.textContent = formatBytes(item.file.size);
      div.appendChild(sizeTag);

      previewGrid.appendChild(div);
    });
  }

  // Blur toggle
  blurToggleBtn.addEventListener('click', () => {
    isBlurred = !isBlurred;
    if (isBlurred) {
      blurToggleBtn.classList.add('active');
      blurIcon.textContent = '🙈';
      blurText.textContent = 'Privacy Blur ON';
      document.querySelectorAll('.preview-item').forEach(el => el.classList.add('blurred'));
    } else {
      blurToggleBtn.classList.remove('active');
      blurIcon.textContent = '👁️';
      blurText.textContent = 'Privacy Blur OFF';
      document.querySelectorAll('.preview-item').forEach(el => el.classList.remove('blurred'));
    }
  });

  // Send upload handler
  sendBtn.addEventListener('click', () => {
    if (selectedFiles.length === 0) return;

    sendBtn.disabled = true;
    sendBtnText.textContent = 'Uploading...';
    progressContainer.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressStatus.textContent = 'Starting upload...';

    const formData = new FormData();
    selectedFiles.forEach(item => {
      formData.append('files', item.file);
    });
    const noteText = noteInput.value.trim();
    if (noteText) {
      formData.append('note', noteText);
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?token=${encodeURIComponent(token)}`);
    xhr.setRequestHeader('x-vault-token', token);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = `${percent}%`;
        progressStatus.textContent = `Uploading... ${percent}% (${formatBytes(e.loaded)} / ${formatBytes(e.total)})`;
      }
    };

    xhr.onload = () => {
      sendBtn.disabled = false;
      sendBtnText.textContent = 'Send to Vault';
      progressContainer.classList.add('hidden');

      if (xhr.status === 200) {
        // Success
        const uploadedCount = selectedFiles.length;
        // Clean up object URLs
        for (const item of selectedFiles) {
          URL.revokeObjectURL(item.objectUrl);
        }
        selectedFiles = [];
        noteInput.value = '';
        queueSection.classList.add('hidden');

        successMessage.textContent = `Successfully saved ${uploadedCount} file${uploadedCount > 1 ? 's' : ''} directly to his computer.`;
        successCard.classList.remove('hidden');
      } else {
        alert('Upload failed: ' + (xhr.responseText || 'Server error'));
      }
    };

    xhr.onerror = () => {
      sendBtn.disabled = false;
      sendBtnText.textContent = 'Send to Vault';
      progressContainer.classList.add('hidden');
      alert('Network error while uploading. Please check connection.');
    };

    xhr.send(formData);
  });

  // Upload more button
  uploadMoreBtn.addEventListener('click', () => {
    successCard.classList.add('hidden');
  });

  // Lock Vault now
  lockVaultBtn.addEventListener('click', () => {
    if (confirm('Seal the vault now and close this connection?')) {
      fetch(`/api/lock?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'x-vault-token': token }
      }).finally(() => {
        lockOut('You locked the vault. Connection closed safely.');
      });
    }
  });
})();
