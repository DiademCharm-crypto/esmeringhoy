/* ============================================================================
   ESMERINGHOY — ADMIN PANEL LOGIC
   ----------------------------------------------------------------------------
   Catalog CRUD + reordering + catalog.js export, plus the direct-to-Backblaze
   upload flow. No backend anywhere: edits persist in localStorage via store.js,
   and uploads are presigned in this page (signv4.js) and PUT straight to B2.
   ========================================================================== */

(function () {
  var Store = window.EsmeringhoyStore;
  var SigV4 = window.EshSigV4;

  var CONNECTION_KEY = "esh_b2_connection";

  var listEl = document.getElementById("admin-list");
  var statusEl = document.getElementById("admin-status");
  var editor = document.getElementById("editor");
  var editorTitle = document.getElementById("editor-title");
  var form = document.getElementById("editor-form");
  var errorEl = document.getElementById("editor-error");
  var videoField = document.getElementById("f-video");
  var thumbPreview = document.getElementById("thumb-preview");

  var uploadStatus = document.getElementById("upload-status");
  var uploadProgress = document.getElementById("upload-progress");
  var uploadBar = document.getElementById("upload-bar");
  var uploadPicked = document.getElementById("upload-picked");
  var uploadBtn = document.getElementById("btn-upload");
  var uploadCancelBtn = document.getElementById("btn-cancel-upload");
  var grabPoster = document.getElementById("f-grab-poster");

  var chosenFile = null;
  var activeRequest = null;

  var editingIndex = -1; /* -1 = creating a new clip */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  /* ---------------------------------------------------------------- status */

  function renderStatus() {
    var n = Store.videos().length;
    var dirty = Store.hasLocalEdits();
    statusEl.textContent = n + (n === 1 ? " clip" : " clips") + " · " +
      (dirty ? "local edits active (not published)" : "showing published catalog.js");
    statusEl.classList.toggle("dirty", dirty);
    document.getElementById("btn-reset").disabled = !dirty;
    renderConnectionStatus();
  }

  /* ------------------------------------------------------- B2 connection UI */

  var connFields = {
    base: document.getElementById("media-base"),
    signEndpoint: document.getElementById("media-sign-endpoint"),
    endpoint: document.getElementById("b2-endpoint"),
    bucket: document.getElementById("b2-bucket"),
    keyId: document.getElementById("b2-key-id"),
    appKey: document.getElementById("b2-app-key"),
    prefix: document.getElementById("b2-prefix"),
    region: document.getElementById("b2-region"),
    remember: document.getElementById("b2-remember")
  };

  function regionFromEndpoint(endpoint) {
    var match = /s3\.([a-z]{2}-[a-z]+-\d{3})\.backblazeb2\.com/.exec(endpoint || "");
    return match ? match[1] : "";
  }

  function readConnection() {
    var endpoint = connFields.endpoint.value.trim().replace(/\/+$/, "");
    var region = connFields.region.value.trim() || regionFromEndpoint(endpoint);
    return {
      base: connFields.base.value.trim().replace(/\/+$/, ""),
      signEndpoint: connFields.signEndpoint.value.trim(),
      endpoint: endpoint,
      bucket: connFields.bucket.value.trim(),
      keyId: connFields.keyId.value.trim(),
      appKey: connFields.appKey.value,
      prefix: connFields.prefix.value.trim().replace(/^\/+|\/+$/g, ""),
      region: region,
      remember: connFields.remember.checked
    };
  }

  /* Everything that must be true before a signature is even attempted. */
  function connectionProblem(conn) {
    if (!conn.endpoint) return "Add the S3 endpoint from your bucket's details.";
    if (!/^https?:\/\//i.test(conn.endpoint)) return "The S3 endpoint must start with https://";
    if (/^http:\/\//i.test(conn.endpoint) && !/^http:\/\/(127\.0\.0\.1|localhost)/i.test(conn.endpoint)) {
      return "Use https:// — a plain http endpoint would send your key in the clear.";
    }
    if (!conn.bucket) return "Add the bucket name.";
    if (!conn.keyId) return "Add the application key ID.";
    if (!conn.appKey) return "Add the application key.";
    if (!conn.region) {
      return "Could not read a region from the endpoint. Set Region to the cluster name, " +
        "for example us-west-004 or eu-central-003.";
    }
    return null;
  }

  function clipsUsingPaths() {
    return Store.videos().filter(function (v) {
      return v.video && !/^https?:\/\//i.test(v.video);
    }).length;
  }

  function renderConnectionStatus() {
    var conn = readConnection();
    var problem = connectionProblem(conn);
    var parts = [];

    if (!conn.base) {
      var usingPaths = clipsUsingPaths();
      parts.push(usingPaths
        ? "No playback base URL: " + usingPaths + " clip(s) store a bucket path and will not play."
        : "No playback base URL set.");
    } else {
      parts.push("Playback base: " + conn.base);
    }

    if (conn.signEndpoint) parts.push("signed URLs via " + conn.signEndpoint);

    if (problem) parts.push("Uploads off — " + problem);
    else parts.push("Uploads ready → " + conn.endpoint + "/" + conn.bucket);

    if (conn.remember && conn.keyId) parts.push("keys saved in this browser");
    else if (conn.keyId) parts.push("keys held in memory for this tab only");

    var el = document.getElementById("b2-status");
    el.textContent = parts.join(" · ");
    el.classList.toggle("warn", Boolean(problem));

    var state = document.getElementById("b2-panel-state");
    state.textContent = conn.bucket ? conn.bucket : "not configured";
    state.classList.toggle("warn", Boolean(problem));
  }

  function applyConnection(conn) {
    connFields.base.value = conn.base || "";
    connFields.signEndpoint.value = conn.signEndpoint || "";
    connFields.endpoint.value = conn.endpoint || "";
    connFields.bucket.value = conn.bucket || "";
    connFields.keyId.value = conn.keyId || "";
    connFields.appKey.value = conn.appKey || "";
    connFields.prefix.value = conn.prefix || "";
    connFields.region.value = conn.region || "";
    connFields.remember.checked = Boolean(conn.remember);
  }

  function loadConnection() {
    var saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(CONNECTION_KEY) || "null");
    } catch (e) {
      saved = null;
    }
    if (saved) applyConnection(saved);
    else connFields.prefix.value = "clips";

    /* The published catalog already knows where the site loads media from, so
       seed the two URL fields from it. Without this an opening panel shows
       blank inputs — and the Statistics section reads "needs the sign
       endpoint" even though the live site is signed. */
    if (!connFields.base.value.trim() && Store.mediaBaseUrl()) {
      connFields.base.value = Store.mediaBaseUrl();
    }
    if (!connFields.signEndpoint.value.trim() && Store.mediaSignEndpoint()) {
      connFields.signEndpoint.value = Store.mediaSignEndpoint();
    }
    renderConnectionStatus();
  }

  function persistConnection() {
    var conn = readConnection();
    if (conn.remember) {
      try {
        localStorage.setItem(CONNECTION_KEY, JSON.stringify(conn));
      } catch (e) {
        console.warn("Could not save the connection:", e);
      }
    } else {
      try {
        localStorage.removeItem(CONNECTION_KEY);
      } catch (e) {}
    }
    return conn;
  }

  /* ------------------------------------------------------ media URL preview */

  function resolveMediaUrl(value) {
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    var base = readConnection().base || Store.mediaBaseUrl();
    if (!base) return null;
    return base.replace(/\/+$/, "") + "/" + String(value).replace(/^\/+/, "");
  }

  function renderVideoPreview() {
    var el = document.getElementById("f-video-preview");
    var value = videoField.value.trim();
    if (!value) {
      el.textContent = "Set a path like clips/scene-01.mp4, or paste a full URL.";
      el.classList.remove("ok", "warn");
      return;
    }
    var resolved = resolveMediaUrl(value);
    if (!resolved) {
      el.textContent = "→ " + value + " (set a playback base URL above, or paste a full URL)";
      el.classList.add("warn");
      el.classList.remove("ok");
      return;
    }
    el.textContent = "→ " + resolved +
      (window.eshIsHls(resolved) ? "  (HLS: quality switches automatically)" : "");
    el.classList.add("ok");
    el.classList.remove("warn");
  }

  /* ------------------------------------------------------------ upload flow */

  function prettyBytes(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + " GB";
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
    return bytes + " B";
  }

  function setUploadStatus(message, kind) {
    uploadStatus.textContent = message || "";
    uploadStatus.classList.remove("ok", "warn", "error");
    if (kind) uploadStatus.classList.add(kind);
  }

  function sanitizeName(name) {
    return String(name || "video")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+/, "")
      .slice(0, 80) || "video";
  }

  function extensionOf(name) {
    var match = /(\.[A-Za-z0-9]{2,5})$/.exec(name || "");
    return match ? match[1].toLowerCase() : ".mp4";
  }

  function joinKey(prefix, name) {
    return prefix ? prefix + "/" + name : name;
  }

  function contentTypeFor(name) {
    var ext = extensionOf(name);
    if (ext === ".webm") return "video/webm";
    if (ext === ".mov") return "video/quicktime";
    if (ext === ".mkv") return "video/x-matroska";
    if (ext === ".m3u8") return "application/vnd.apple.mpegurl";
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    return "video/mp4";
  }

  function setupUploadUi() {
    var drop = document.getElementById("upload-drop");
    var input = document.getElementById("f-file");

    function acceptFile(file) {
      if (!file) return;
      chosenFile = file;
      var durationNote = "";
      probeDuration(file).then(function (seconds) {
        durationNote = seconds ? " · " + formatDuration(seconds) : " · duration unreadable";
        uploadPicked.textContent = file.name + " · " + prettyBytes(file.size) + durationNote;
      });
      uploadPicked.textContent = file.name + " · " + prettyBytes(file.size);
      uploadBtn.disabled = false;
      setUploadStatus("");
    }

    input.addEventListener("change", function () {
      acceptFile(input.files && input.files[0]);
    });

    ["dragenter", "dragover"].forEach(function (evt) {
      drop.addEventListener(evt, function (e) {
        e.preventDefault();
        drop.classList.add("dragging");
      });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      drop.addEventListener(evt, function (e) {
        e.preventDefault();
        drop.classList.remove("dragging");
      });
    });
    drop.addEventListener("drop", function (e) {
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) acceptFile(file);
    });

    /* The whole editor accepts a drop, which is how people actually behave. */
    editor.addEventListener("dragover", function (e) { e.preventDefault(); });
    editor.addEventListener("drop", function (e) {
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) {
        e.preventDefault();
        acceptFile(file);
      }
    });

    uploadBtn.addEventListener("click", startUpload);
    uploadCancelBtn.addEventListener("click", function () {
      if (activeRequest) activeRequest.abort();
    });
  }

  function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    function pad(n) { return n < 10 ? "0" + n : String(n); }
    return (h ? h + ":" + pad(m) : String(m)) + ":" + pad(s);
  }

  /* Reading duration locally means the clip gets a real runtime without a
     server probing it. Codecs the browser cannot decode simply return null. */
  function probeDuration(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var video = document.createElement("video");
      var settled = false;
      function done(value) {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(value);
      }
      video.preload = "metadata";
      video.muted = true;
      video.onloadedmetadata = function () {
        done(isFinite(video.duration) && video.duration > 0 ? video.duration : null);
      };
      video.onerror = function () { done(null); };
      setTimeout(function () { done(null); }, 8000);
      video.src = url;
    });
  }

  /* Grabs a frame so the site's thumbnail actually looks like the video. */
  function grabPosterFrame(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var video = document.createElement("video");
      var settled = false;
      function done(blob) {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(blob);
      }
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.onloadedmetadata = function () {
        var target = Math.min(2, Math.max(0.1, (video.duration || 4) * 0.1));
        video.onseeked = function () {
          try {
            if (!video.videoWidth) return done(null);
            var width = video.videoWidth;
            var height = video.videoHeight;
            var maxWidth = 1280;
            if (width > maxWidth) {
              height = Math.round(height * (maxWidth / width));
              width = maxWidth;
            }
            var canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            canvas.getContext("2d").drawImage(video, 0, 0, width, height);
            canvas.toBlob(function (blob) { done(blob); }, "image/jpeg", 0.72);
          } catch (e) {
            done(null);
          }
        };
        video.currentTime = target;
      };
      video.onerror = function () { done(null); };
      setTimeout(function () { done(null); }, 12000);
      video.src = url;
    });
  }

  /* Uploads one blob with progress. XHR instead of fetch because fetch still
     cannot report upload progress. */
  function putObject(conn, key, blob, contentType, onProgress) {
    return SigV4.presignUrl({
      method: "PUT",
      endpoint: conn.endpoint,
      bucket: conn.bucket,
      key: key,
      region: conn.region,
      accessKeyId: conn.keyId,
      secretAccessKey: conn.appKey,
      expiresIn: 3600
    }).then(function (signed) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        activeRequest = xhr;
        var startedAt = Date.now();

        xhr.open("PUT", signed.url, true);
        xhr.setRequestHeader("Content-Type", contentType);

        xhr.upload.onprogress = function (e) {
          if (!e.lengthComputable || !onProgress) return;
          var seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
          onProgress(e.loaded / e.total, e.loaded, e.loaded / seconds);
        };

        xhr.onload = function () {
          activeRequest = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve({ status: xhr.status, etag: xhr.getResponseHeader("ETag") });
          } else {
            reject(new Error("Backblaze answered HTTP " + xhr.status +
              (xhr.responseText ? " — " + String(xhr.responseText).slice(0, 200) : "")));
          }
        };

        xhr.onerror = function () {
          activeRequest = null;
          reject(new Error("The upload never reached Backblaze. This is almost always a missing " +
            "CORS rule on the bucket — run: node tools/b2-setup.mjs"));
        };

        xhr.onabort = function () {
          activeRequest = null;
          reject(new Error("Cancelled."));
        };

        xhr.send(blob);
      });
    });
  }

  function startUpload() {
    if (!chosenFile) return;

    var conn = readConnection();
    var problem = connectionProblem(conn);
    if (problem) {
      setUploadStatus(problem, "error");
      document.getElementById("b2-panel").open = true;
      return;
    }

    var file = chosenFile;
    var baseName = sanitizeName(file.name.replace(/\.[^.]+$/, "")) || "clip";
    var key = joinKey(conn.prefix, baseName + extensionOf(file.name));
    var posterKey = joinKey(conn.prefix, baseName + "-poster.jpg");
    var contentType = file.type && /^video\//.test(file.type) ? file.type : contentTypeFor(file.name);

    uploadBtn.disabled = true;
    uploadCancelBtn.hidden = false;
    uploadProgress.hidden = false;
    uploadBar.style.width = "0%";
    setUploadStatus("Signing and uploading " + file.name + "…");

    putObject(conn, key, file, contentType, function (fraction, loaded, bytesPerSecond) {
      uploadBar.style.width = Math.round(fraction * 100) + "%";
      setUploadStatus("Uploading " + Math.round(fraction * 100) + "% · " +
        prettyBytes(loaded) + " of " + prettyBytes(file.size) + " · " +
        prettyBytes(bytesPerSecond) + "/s");
    }).then(function () {
      videoField.value = key;
      renderVideoPreview();

      if (!document.getElementById("f-title").value.trim()) {
        document.getElementById("f-title").value = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
      }

      var follow = [];
      if (!document.getElementById("f-duration").value.trim()) {
        follow.push(probeDuration(file).then(function (seconds) {
          if (seconds) document.getElementById("f-duration").value = formatDuration(seconds);
        }));
      }
      if (grabPoster.checked) {
        follow.push(grabPosterFrame(file).then(function (blob) {
          if (!blob) return null;
          return putObject(conn, posterKey, blob, "image/jpeg").then(function () {
            document.getElementById("f-poster").value = posterKey;
            updateThumbPreview();
          });
        }));
      }

      return Promise.all(follow).then(function () {
        uploadBar.style.width = "100%";
        var resolved = resolveMediaUrl(key);
        setUploadStatus("Uploaded to " + conn.bucket + "/" + key +
          (resolved ? "\n" + resolved : "") +
          "\nSave the clip, then Download catalog.js to publish.", "ok");
      });
    }).catch(function (err) {
      setUploadStatus(String(err && err.message || err), "error");
    }).then(function () {
      uploadBtn.disabled = false;
      uploadCancelBtn.hidden = true;
      activeRequest = null;
    });
  }

  /* ------------------------------------------------------------------ list */

  function renderList() {
    var videos = Store.videos();
    listEl.innerHTML = "";

    if (!videos.length) {
      listEl.innerHTML = '<p class="no-results">No clips yet. Use “+ Add clip”.</p>';
      return;
    }

    videos.forEach(function (v, i) {
      var url = window.eshMediaUrl(v);
      var poster = window.eshPosterStart(v);
      var row = document.createElement("div");
      row.className = "admin-row";

      row.innerHTML =
        '<img class="admin-thumb" src="' + esc(poster.src) + '" alt=""' +
          (poster.pending ? ' data-poster-key="' + esc(poster.key) + '"' : "") + '>' +
        '<div class="admin-row-body">' +
          '<div class="admin-row-title">' + esc(v.title) + "</div>" +
          '<div class="admin-row-meta">' +
            "<span><code>" + esc(v.id) + "</code></span>" +
            '<span class="' + (url ? "ok" : "warn") + '">' +
              (url ? (window.eshIsHls(url) ? "HLS ladder" : "video linked") : "no video") + "</span>" +
            "<span>" + esc(v.duration || "—") + "</span>" +
            "<span>" + esc(v.rating) + "%</span>" +
          "</div>" +
          '<div class="admin-row-tags">' +
            (v.tags || []).map(function (t) {
              return '<span class="tag-chip">' + esc(t) + "</span>";
            }).join("") +
          "</div>" +
        "</div>" +
        '<div class="admin-row-actions">' +
          '<button type="button" class="icon-btn up" title="Move up"' + (i === 0 ? " disabled" : "") + ">&uarr;</button>" +
          '<button type="button" class="icon-btn down" title="Move down"' + (i === videos.length - 1 ? " disabled" : "") + ">&darr;</button>" +
          '<button type="button" class="icon-btn edit" title="Edit">Edit</button>' +
          '<button type="button" class="icon-btn del" title="Delete">&times;</button>' +
        "</div>";

      row.querySelector(".up").addEventListener("click", function () { move(i, -1); });
      row.querySelector(".down").addEventListener("click", function () { move(i, 1); });
      row.querySelector(".edit").addEventListener("click", function () { openEditor(i); });
      row.querySelector(".del").addEventListener("click", function () { remove(i); });
      listEl.appendChild(row);
    });

    signListThumbnails();
    /* The statistics filter lists clips, so it follows the catalog. */
    populateStatsClipFilter();
  }

  /* Thumbnails on a private bucket need signatures too — one request per list. */
  function signListThumbnails() {
    var images = listEl.querySelectorAll("img[data-poster-key]");
    if (!images.length) return;
    var keys = [].map.call(images, function (img) { return img.getAttribute("data-poster-key"); });
    window.eshSignedUrls(keys).then(function (signed) {
      [].forEach.call(images, function (img) {
        var key = img.getAttribute("data-poster-key");
        if (signed[key]) img.src = signed[key];
      });
    });
  }

  function move(index, delta) {
    var videos = Store.videos();
    var target = index + delta;
    if (target < 0 || target >= videos.length) return;
    var tmp = videos[index];
    videos[index] = videos[target];
    videos[target] = tmp;
    Store.save(videos);
    renderStatus();
    renderList();
    /* Keep focus on the same row so repeated clicks keep working. */
    var rows = listEl.querySelectorAll(".admin-row");
    if (rows[target]) {
      var btn = rows[target].querySelector(delta < 0 ? ".up" : ".down");
      if (btn && !btn.disabled) btn.focus();
    }
  }

  function remove(index) {
    var videos = Store.videos();
    var label = videos[index].title;
    if (!window.confirm('Delete "' + label + '"? This cannot be undone.')) return;
    videos.splice(index, 1);
    Store.save(videos);
    renderStatus();
    renderList();
  }

  /* ---------------------------------------------------------------- editor */

  function updateThumbPreview() {
    var url = document.getElementById("f-poster").value.trim();
    var title = document.getElementById("f-title").value.trim();
    var preview = {
      id: document.getElementById("f-id").value.trim() || "preview",
      title: title || "Untitled",
      poster: url || null
    };
    var poster = window.eshPosterStart(preview);

    thumbPreview.innerHTML = "";
    var img = document.createElement("img");
    img.src = poster.src;
    img.alt = "";
    thumbPreview.appendChild(img);

    if (poster.pending) {
      var key = poster.key;
      window.eshSignedUrls([key]).then(function (signed) {
        if (signed[key] && img.isConnected) img.src = signed[key];
      });
    }
  }

  function resetUploadUi() {
    chosenFile = null;
    document.getElementById("f-file").value = "";
    uploadPicked.textContent = "No file chosen yet.";
    uploadBtn.disabled = true;
    uploadCancelBtn.hidden = true;
    uploadProgress.hidden = true;
    uploadBar.style.width = "0%";
    setUploadStatus("");
  }

  function openEditor(index) {
    editingIndex = index;
    var v = index >= 0 ? Store.videos()[index] : null;

    editorTitle.textContent = v ? "Edit clip" : "Add clip";
    errorEl.hidden = true;
    resetUploadUi();

    document.getElementById("f-title").value = v ? v.title : "";
    document.getElementById("f-id").value = v ? v.id : "";
    document.getElementById("f-duration").value = v ? (v.duration || "") : "";
    document.getElementById("f-poster").value = v && v.poster ? v.poster : "";
    document.getElementById("f-views").value = v ? (v.views || 0) : 0;
    document.getElementById("f-rating").value = v ? (v.rating || 0) : 100;
    document.getElementById("f-added").value = v ? (v.added || today()) : today();
    document.getElementById("f-tags").value = v ? (v.tags || []).join(", ") : "";

    videoField.value = v && v.video ? v.video : "";

    updateThumbPreview();
    renderVideoPreview();
    editor.hidden = false;
    document.getElementById("f-title").focus();
  }

  function closeEditor() {
    editor.hidden = true;
    editingIndex = -1;
    if (activeRequest) activeRequest.abort();
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    var title = document.getElementById("f-title").value.trim();
    if (!title) return showError("Give the clip a title.");

    var poster = document.getElementById("f-poster").value.trim();

    var mediaUrl = videoField.value.trim();

    var video = {
      id: document.getElementById("f-id").value.trim(),
      title: title,
      poster: poster || null,
      video: mediaUrl || null,
      duration: document.getElementById("f-duration").value.trim() || "00:00",
      views: Number(document.getElementById("f-views").value) || 0,
      rating: Math.max(0, Math.min(100, Number(document.getElementById("f-rating").value) || 0)),
      added: document.getElementById("f-added").value || today(),
      tags: document.getElementById("f-tags").value
        .split(",")
        .map(function (t) { return t.trim(); })
        .filter(Boolean)
    };

    var videos = Store.videos();

    if (!video.id) {
      video.id = Store.slugify(video.title);
    }

    /* Reject duplicate ids — the id is what the player URL resolves on. */
    var clash = videos.some(function (v, i) {
      return v.id === video.id && i !== editingIndex;
    });
    if (clash) {
      video.id = Store.slugify(video.id);
      if (videos.some(function (v, i) { return v.id === video.id && i !== editingIndex; })) {
        video.id = video.id + "-" + Date.now().toString(36).slice(-4);
      }
    }

    if (editingIndex >= 0) videos[editingIndex] = video;
    else videos.push(video);

    Store.save(videos);
    renderStatus();
    renderList();
    closeEditor();
  });

  /* ---------------------------------------------------------------- actions */

  document.getElementById("btn-add").addEventListener("click", function () { openEditor(-1); });
  document.getElementById("btn-cancel").addEventListener("click", closeEditor);
  document.getElementById("f-poster").addEventListener("input", updateThumbPreview);
  videoField.addEventListener("input", renderVideoPreview);
  document.getElementById("f-title").addEventListener("input", function () {
    var idField = document.getElementById("f-id");
    if (editingIndex < 0 && !idField.dataset.touched) {
      idField.placeholder = Store.slugify(this.value) || "auto from title";
    }
    updateThumbPreview();
  });
  document.getElementById("f-id").addEventListener("input", function () {
    this.dataset.touched = "1";
  });

  Object.keys(connFields).forEach(function (name) {
    connFields[name].addEventListener("input", renderConnectionStatus);
    connFields[name].addEventListener("change", renderConnectionStatus);
  });

  document.getElementById("btn-save-b2").addEventListener("click", function () {
    var btn = this;
    var conn = persistConnection();
    /* Base URL and sign endpoint live in the catalog so the site reads them too. */
    Store.saveMediaSignEndpoint(conn.signEndpoint);
    Store.saveMediaBaseUrl(conn.base);
    var problem = connectionProblem(conn);
    renderStatus();
    renderVideoPreview();
    btn.textContent = problem ? "Saved with warnings" : "Saved ✓";
    setTimeout(function () { btn.textContent = "Save connection"; }, 1600);
  });

  document.getElementById("btn-forget-b2").addEventListener("click", function () {
    if (!window.confirm("Remove the stored Backblaze keys from this browser?")) return;
    try {
      localStorage.removeItem(CONNECTION_KEY);
    } catch (e) {}
    connFields.keyId.value = "";
    connFields.appKey.value = "";
    connFields.remember.checked = false;
    renderVideoPreview();
    renderConnectionStatus();
    setUploadStatus("Keys cleared from this browser.", "ok");
  });

  editor.addEventListener("click", function (e) {
    if (e.target === editor) closeEditor();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !editor.hidden) closeEditor();
  });

  function catalogText() {
    return Store.exportCatalogJs();
  }

  document.getElementById("btn-download").addEventListener("click", function () {
    var blob = new Blob([catalogText()], { type: "text/javascript" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "catalog.js";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  });

  document.getElementById("btn-copy").addEventListener("click", function () {
    var btn = this;
    var text = catalogText();
    function done(ok) {
      btn.textContent = ok ? "Copied ✓" : "Copy failed";
      setTimeout(function () { btn.textContent = "Copy catalog.js"; }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  });

  document.getElementById("btn-reset").addEventListener("click", function () {
    if (!window.confirm("Discard local edits and go back to the published catalog.js?")) return;
    Store.reset();
    document.getElementById("media-base").value = Store.mediaBaseUrl();
    document.getElementById("media-sign-endpoint").value = Store.mediaSignEndpoint();
    renderStatus();
    renderList();
    renderVideoPreview();
  });

  /* ==========================================================================
     STATISTICS
     --------------------------------------------------------------------------
     Reads the CDN Worker's /stats route, which aggregates the playback sessions
     the player reports. The password is the Worker's STATS_TOKEN: it is kept in
     this browser only, and never written into catalog.js, so publishing the
     catalog cannot leak it.
     ========================================================================== */

  var STATS_KEY = "esh_stats_connection";
  var SELF_KEY = "esh_track_self";

  var statsFields = {
    endpoint: document.getElementById("stats-endpoint"),
    token: document.getElementById("stats-token"),
    remember: document.getElementById("stats-remember"),
    self: document.getElementById("stats-self"),
    range: document.getElementById("stats-range"),
    clip: document.getElementById("stats-clip-filter")
  };

  var statsStatusEl = document.getElementById("stats-status");
  var statsHelpEl = document.getElementById("stats-help");
  var statsResultsEl = document.getElementById("stats-results");
  var statsTotalsEl = document.getElementById("stats-totals");
  var statsDailyEl = document.getElementById("stats-daily");
  var statsClipsEl = document.getElementById("stats-clips");
  var statsWhereEl = document.getElementById("stats-where");

  var lastStats = null;

  /* The statistics route sits beside the signing route on the same Worker, so
     configuring one configures both. */
  function derivedStatsEndpoint() {
    var explicit = statsFields.endpoint.value.trim();
    if (explicit) return explicit;
    var sign = connFields.signEndpoint.value.trim();
    if (/\/token\b/.test(sign)) return sign.replace(/\/token\b[^/]*$/, "/stats");
    return "";
  }

  function statsStatus(message, kind) {
    statsStatusEl.textContent = message || "";
    statsStatusEl.classList.remove("ok", "warn", "error");
    if (kind) statsStatusEl.classList.add(kind);
  }

  function showStatsHelp(lines) {
    statsHelpEl.innerHTML = (lines || [])
      .map(function (line) { return "<div>" + esc(line) + "</div>"; })
      .join("");
    statsHelpEl.hidden = !(lines && lines.length);
  }

  /* A clip is identified in the statistics by its bucket path — the same key
     the signature covers. */
  function statsKeyFor(video) {
    var value = video && video.video;
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return window.eshMediaKeyFor(value);
    return String(value).replace(/^\/+/, "");
  }

  function fmtNumber(n) {
    return Number(n || 0).toLocaleString();
  }

  function fmtWatch(seconds) {
    var s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    var h = Math.floor(m / 60);
    if (h < 48) return h + "h " + (m % 60) + "m";
    return Math.round(h / 24) + "d " + (h % 24) + "h";
  }

  function fmtWhen(unixSeconds) {
    if (!unixSeconds) return "—";
    var seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(unixSeconds));
    if (seconds < 90) return "just now";
    if (seconds < 5400) return Math.round(seconds / 60) + " min ago";
    if (seconds < 172800) return Math.round(seconds / 3600) + " h ago";
    if (seconds < 2592000) return Math.round(seconds / 86400) + " days ago";
    return new Date(Number(unixSeconds) * 1000).toLocaleDateString();
  }

  function populateStatsClipFilter() {
    var current = statsFields.clip.value;
    statsFields.clip.innerHTML = '<option value="">All clips</option>';
    Store.videos().forEach(function (v) {
      var key = statsKeyFor(v);
      if (!key) return;
      var option = document.createElement("option");
      option.value = key;
      option.textContent = v.title;
      statsFields.clip.appendChild(option);
    });
    if (current) statsFields.clip.value = current;
  }

  function renderStatsTotals(totals) {
    var cells = [
      { label: "Views", value: fmtNumber(totals.views), note: "playback sessions that really started" },
      { label: "Watch time", value: fmtWatch(totals.watchSeconds), note: totals.watchHours + " hours" },
      { label: "Avg per view", value: fmtWatch(totals.avgSeconds), note: "forward watch time only" },
      { label: "Finished", value: fmtNumber(totals.completions),
        note: totals.views ? Math.round((totals.completions / totals.views) * 100) + "% of views" : "—" },
      { label: "Viewers", value: fmtNumber(totals.uniqueViewers), note: "distinct per day" },
      { label: "Last view", value: fmtWhen(totals.lastSeen), note: "" }
    ];

    statsTotalsEl.innerHTML = cells.map(function (cell) {
      return '<div class="stat-card"><div class="stat-label">' + esc(cell.label) + "</div>" +
        '<div class="stat-value">' + esc(cell.value) + "</div>" +
        (cell.note ? '<div class="stat-note">' + esc(cell.note) + "</div>" : "") +
        "</div>";
    }).join("");
  }

  /* Horizontal bars: no chart library, no canvas, and it stays readable on a
     phone, which a 90-day line chart would not. */
  function renderStatsDaily(daily) {
    var rows = (daily || []).slice(0, 30);
    if (!rows.length) {
      statsDailyEl.innerHTML = '<p class="stat-empty">No views in this range yet.</p>';
      return;
    }
    var peak = rows.reduce(function (max, row) { return Math.max(max, row.views); }, 1);
    statsDailyEl.innerHTML = rows.map(function (row) {
      var width = Math.max(2, Math.round((row.views / peak) * 100));
      return '<div class="stat-bar-row">' +
        '<span class="stat-bar-day">' + esc(row.day) + "</span>" +
        '<span class="stat-bar-track"><span class="stat-bar-fill" style="width:' + width + '%"></span></span>' +
        '<span class="stat-bar-value">' + fmtNumber(row.views) +
          ' <em>' + esc(fmtWatch(row.watchSeconds)) + "</em></span>" +
        "</div>";
    }).join("");
  }

  function renderStatsClips(clips) {
    var tbody = statsClipsEl.querySelector("tbody");
    tbody.innerHTML = "";

    if (!clips || !clips.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="stat-empty">No views recorded yet.</td></tr>';
      return;
    }

    clips.forEach(function (clip) {
      var match = null;
      Store.videos().forEach(function (v) {
        if (!match && statsKeyFor(v) === clip.key) match = v;
      });

      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + (match
          ? '<a href="player.html?id=' + encodeURIComponent(match.id) + '" target="_blank" rel="noopener">' +
            esc(match.title) + "</a>"
          : '<code>' + esc(clip.key) + "</code>" +
            ' <span class="stat-note">(not in the catalog)</span>') + "</td>" +
        '<td class="num">' + fmtNumber(clip.views) + "</td>" +
        '<td class="num">' + esc(fmtWatch(clip.watchSeconds)) + "</td>" +
        '<td class="num">' + esc(fmtWatch(clip.avgSeconds)) + "</td>" +
        '<td class="num">' + fmtNumber(clip.completions) + "</td>" +
        '<td class="num">' + fmtNumber(clip.uniqueViewers) + "</td>" +
        "<td>" + esc(fmtWhen(clip.lastSeen)) + "</td>";
      tbody.appendChild(tr);
    });
  }

  function renderStatsWhere(totals) {
    var parts = [];
    var devices = (totals.devices || []).filter(function (d) { return d.device; });
    if (devices.length) {
      parts.push("devices: " + devices.map(function (d) {
        return d.device + " " + fmtNumber(d.views);
      }).join(", "));
    }
    var countries = (totals.countries || []).filter(function (c) { return c.country; });
    if (countries.length) {
      parts.push("countries: " + countries.map(function (c) {
        return c.country + " " + fmtNumber(c.views);
      }).join(", "));
    }
    statsWhereEl.textContent = parts.join("   ·   ");
  }

  function renderStats(data) {
    lastStats = data;
    statsResultsEl.hidden = false;
    renderStatsTotals(data.totals);
    renderStatsDaily(data.daily);
    renderStatsClips(data.clips);
    renderStatsWhere(data.totals);
    document.getElementById("stats-panel-state").textContent =
      fmtNumber(data.totals.views) + (data.totals.views === 1 ? " view" : " views");
  }

  function loadStats() {
    var endpoint = derivedStatsEndpoint();
    var token = statsFields.token.value.trim();
    var button = document.getElementById("btn-stats-load");

    showStatsHelp(null);

    if (!endpoint) {
      statsStatus("No statistics endpoint. Set the signed-URL endpoint above (the Worker's " +
        "/token route) and the /stats route is used automatically.", "warn");
      return;
    }
    if (!token) {
      statsStatus("Enter the STATS_TOKEN you set on the Worker.", "warn");
      return;
    }

    if (statsFields.remember.checked) {
      try {
        localStorage.setItem(STATS_KEY, JSON.stringify({ endpoint: statsFields.endpoint.value.trim(), token: token }));
      } catch (e) {}
    } else {
      try {
        localStorage.removeItem(STATS_KEY);
      } catch (e) {}
    }

    var query = "days=" + encodeURIComponent(statsFields.range.value || "7");
    if (statsFields.clip.value) query += "&key=" + encodeURIComponent(statsFields.clip.value);
    var url = endpoint + (endpoint.indexOf("?") === -1 ? "?" : "&") + query;

    statsStatus("Loading…");
    button.disabled = true;

    function finish() { button.disabled = false; }

    fetch(url, {
      credentials: "omit",
      headers: { Authorization: "Bearer " + token }
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        return { status: response.status, body: body };
      });
    }).then(function (result) {
      finish();

      if (result.status === 200 && result.body && result.body.totals) {
        renderStats(result.body);
        statsStatus("Loaded " + new Date().toLocaleTimeString() + ".", "ok");
        return;
      }

      statsResultsEl.hidden = true;
      var body = result.body || {};
      if (result.status === 401) {
        statsStatus("The Worker rejected that password. It must match STATS_TOKEN exactly.", "error");
      } else if (result.status === 501 && body.setupRequired) {
        statsStatus("Statistics are not switched on yet for this Worker.", "warn");
        showStatsHelp(body.steps || []);
      } else if (result.status === 403) {
        statsStatus("This page's origin is not allowed to call the Worker. Add it to " +
          "SITE_ORIGINS (an admin panel opened from a file sends Origin: null, which " +
          "needs \"*\" or the site's own origin).", "error");
      } else if (result.status === 404) {
        statsStatus("No /stats route at " + endpoint + " — is the Worker deployed with the " +
          "statistics version of the file?", "error");
      } else {
        statsStatus("The Worker answered HTTP " + result.status +
          (body.error ? " (" + body.error + ")" : "") + ".", "error");
      }
    }).catch(function (err) {
      finish();
      statsResultsEl.hidden = true;
      statsStatus("Could not reach " + endpoint + " — " + (err && err.message || err) +
        ". A network error here is usually CORS: check SITE_ORIGINS on the Worker.", "error");
    });
  }

  /* Copies the measured counts into each clip's visible Views field, as a local
     edit — nothing is published until the catalog is downloaded. */
  function applyStatsToCatalog() {
    if (!lastStats || !lastStats.clips || !lastStats.clips.length) {
      statsStatus("Load some statistics first.", "warn");
      return;
    }
    var measured = {};
    lastStats.clips.forEach(function (clip) { measured[clip.key] = clip.views; });

    var videos = Store.videos();
    var changed = 0;
    videos.forEach(function (v) {
      var key = statsKeyFor(v);
      if (!key || !(key in measured)) return;
      if (Number(v.views) === Number(measured[key])) return;
      v.views = Number(measured[key]);
      changed++;
    });

    if (!changed) {
      statsStatus("Every clip already shows its measured views.", "ok");
      return;
    }

    Store.save(videos);
    renderStatus();
    renderList();
    statsStatus("Updated the Views field for " + changed + " clip(s) in your local edits. " +
      "Download catalog.js to publish them.", "ok");
  }

  function loadStatsConnection() {
    var saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STATS_KEY) || "null");
    } catch (e) {}
    if (saved) {
      statsFields.endpoint.value = saved.endpoint || "";
      statsFields.token.value = saved.token || "";
      statsFields.remember.checked = true;
    }
    /* Checked = this browser stops reporting, which is exactly the flag the
       tracker reads. A visitor's browser never opens this panel, so on a fresh
       browser the box is correctly unchecked and their views are counted. */
    try {
      statsFields.self.checked = localStorage.getItem(SELF_KEY) === "off";
    } catch (e) {}
    document.getElementById("stats-panel-state").textContent =
      derivedStatsEndpoint() ? "ready" : "needs the sign endpoint";
  }

  /* Hiding the toggle's meaning in one place: setting this flag is what the
     tracker actually reads. */
  function persistSelfFlag() {
    try {
      if (statsFields.self.checked) localStorage.setItem(SELF_KEY, "off");
      else localStorage.removeItem(SELF_KEY);
    } catch (e) {}
  }

  document.getElementById("btn-stats-load").addEventListener("click", loadStats);
  document.getElementById("btn-stats-apply").addEventListener("click", function () {
    if (!window.confirm("Copy measured views into each clip's Views field as a local edit?")) return;
    applyStatsToCatalog();
  });

  document.getElementById("btn-stats-clear").addEventListener("click", function () {
    try {
      localStorage.removeItem(STATS_KEY);
    } catch (e) {}
    statsFields.token.value = "";
    statsFields.remember.checked = false;
    statsStatus("Password cleared from this browser.", "ok");
  });

  statsFields.range.addEventListener("change", function () {
    if (lastStats) loadStats();
  });
  statsFields.clip.addEventListener("change", function () {
    if (lastStats) loadStats();
  });
  statsFields.self.addEventListener("change", persistSelfFlag);
  statsFields.endpoint.addEventListener("input", function () {
    document.getElementById("stats-panel-state").textContent =
      derivedStatsEndpoint() ? "ready" : "needs the sign endpoint";
  });

  setupUploadUi();
  loadConnection();
  loadStatsConnection();
  populateStatsClipFilter();
  renderStatus();
  renderList();
})();
