(function () {
  const form = document.getElementById("enrich-form");
  const runBtn = document.getElementById("run-btn");
  const urlInput = document.getElementById("article-url");
  const progressArea = document.getElementById("progress-area");
  const progressList = document.getElementById("progress-list");
  const resultsArea = document.getElementById("results-area");

  function addProgress(msg) {
    progressArea.classList.remove("hidden");
    var el = document.createElement("div");
    el.textContent = msg;
    progressList.appendChild(el);
  }

  function clearProgress() {
    progressList.innerHTML = "";
    progressArea.classList.add("hidden");
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function showError(msg) {
    resultsArea.classList.remove("hidden");
    resultsArea.innerHTML =
      '<div class="bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-800 rounded-lg p-6 text-center">' +
      '<p class="text-red-700 dark:text-red-300 font-medium">' + escapeHtml(msg) + '</p>' +
      '<button onclick="this.parentElement.parentElement.classList.add(\'hidden\')" class="mt-4 text-sm text-red-600 dark:text-red-400 underline">Dismiss</button>' +
      '</div>';
  }

  function renderResults(data) {
    resultsArea.classList.remove("hidden");

    var enrichedHtml = data.enriched
      .replace(/\[IG\]([\s\S]*?)\[\/IG\]/g, function (_, content) {
        var trimmedContent = content.trim();
        var matched = null;
        for (var i = 0; i < data.injections.length; i++) {
          if (trimmedContent.indexOf(data.injections[i].fact.substring(0, 30)) !== -1) {
            matched = data.injections[i];
            break;
          }
        }
        var sourceLink = matched
          ? '<a href="' + escapeHtml(matched.sourceFile) + '" target="_blank" rel="noopener" class="text-xs text-amber dark:text-amber-bright underline hover:no-underline block mt-1">Source: ' + escapeHtml(matched.source) + '</a>'
          : "";
        return '<mark class="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">' + escapeHtml(trimmedContent) + '</mark>' + sourceLink;
      })
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br>");

    resultsArea.innerHTML =
      '<div class="grid grid-cols-1 md:grid-cols-2 bg-cream-100 dark:bg-warm-850 border border-cream-400 dark:border-warm-800 rounded-lg overflow-hidden shadow-sm">' +
      '<div class="border-b md:border-b-0 md:border-r border-cream-400 dark:border-warm-800 p-6">' +
      '<div class="text-xs font-semibold text-warm-500 dark:text-cream-500 uppercase tracking-wider mb-4">Original</div>' +
      '<div class="text-sm text-warm-800 dark:text-cream-200 leading-relaxed">' +
      '<p>' + escapeHtml(data.original).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>") + '</p>' +
      '</div></div>' +
      '<div class="p-6">' +
      '<div class="text-xs font-semibold text-warm-500 dark:text-cream-500 uppercase tracking-wider mb-4">Enriched</div>' +
      '<div class="text-sm text-warm-800 dark:text-cream-200 leading-relaxed">' +
      '<p>' + enrichedHtml + '</p>' +
      '</div></div></div>';
  }

  runBtn.addEventListener("click", function () {
    var url = urlInput.value.trim();

    if (!url) {
      showError("Please enter an article URL.");
      return;
    }

    try {
      new URL(url);
    } catch (_) {
      showError("Please enter a valid URL (e.g. https://example.com/article).");
      return;
    }

    var turnstileEl = document.querySelector('[name="cf-turnstile-response"]');
    var turnstileToken = turnstileEl ? turnstileEl.value : "";

    if (!turnstileToken) {
      showError("Please complete the verification challenge.");
      return;
    }

    clearProgress();
    resultsArea.classList.add("hidden");
    runBtn.disabled = true;
    runBtn.textContent = "Processing...";

    addProgress("Sending request...");

    fetch("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url,
        turnstileToken: turnstileToken,
      }),
    })
      .then(function (response) { return response.json().then(function (data) { return { ok: response.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok) {
          var errors = {
            INVALID_URL: "Could not validate that URL. Check that it's correct.",
            WORD_LIMIT: "Article exceeds the 5,000 word limit (" + result.data.wordCount + " words). Try a shorter article.",
            RATE_LIMIT: "Rate limit reached. Try again in " + (result.data.retryAfter || "an hour") + ".",
            TURNSTILE_FAILED: "Verification failed. Please refresh and try again.",
            TURNSTILE_MISSING: "Please complete the verification challenge.",
            FETCH_FAILED: "Could not fetch the article. The site may be blocking requests.",
            FETCH_TIMEOUT: "Request timed out. The article site may be slow or unreachable.",
            FETCH_BLOCKED: "Could not fetch the article. The site may be blocking automated requests.",
            TOKEN_BUDGET: "Article is too large for enrichment. Try a shorter article.",
            ENRICH_FAILED: "The enrichment service encountered an error. Please try again.",
          };
          showError(errors[result.data.error] || "An unexpected error occurred.");
          return;
        }

        addProgress("Enrichment complete. Rendering...");
        renderResults(result.data);
      })
      .catch(function () {
        showError("Network error. Please check your connection and try again.");
      })
      .finally(function () {
        runBtn.disabled = false;
        runBtn.textContent = "Run Enrichment \u2192";
        clearProgress();
      });
  });
})();
