(() => {
  const TARGET_ENTITY_ID = "ENTITYTLD43M1F4RXU";
  const LOCAL_DEBUG_ENDPOINT = "http://localhost:4317/api/debug/network";
  const MAX_THREAD_PAGES = 20;
  const MAX_MESSAGE_PAGES = 20;
  const REQUEST_DELAY_MS = 180;
  const COLLECTOR_VERSION = "0.2.1-brandid";
  const BRAND_ID = "1253403";
  const BRAND_ACTOR_NAME = "Kanrichu";

  if (window.top !== window) return;
  if (window.__kanrichuSilentCollectorLoaded) return;
  window.__kanrichuSilentCollectorLoaded = true;

  const pageUrl = new URL(location.href);
  if (pageUrl.origin !== "https://advertising.amazon.com") return;
  if (pageUrl.pathname !== "/bi") return;
  if (pageUrl.searchParams.get("entityId") !== TARGET_ENTITY_ID) return;

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function saveDebugEvent(event) {
    await fetch(LOCAL_DEBUG_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [event] })
    });
  }

  function absoluteUrl(path) {
    return new URL(path, location.origin).href;
  }

  function makeEvent(url, status, responseText, type = "bulk-api") {
    return {
      sourceUrl: location.href,
      frameUrl: location.href,
      type,
      method: "GET",
      url: absoluteUrl(url),
      status,
      requestBody: "",
      responseText
    };
  }

  async function emit(event) {
    try {
      await saveDebugEvent(event);
    } catch (error) {
      console.warn("[Amazon Aggregator] Failed to save API event:", error);
    }
  }

  async function fetchText(url) {
    const absolute = absoluteUrl(url);
    const response = await fetch(absolute, {
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        brandid: BRAND_ID
      }
    });
    const text = await response.text();
    await emit(makeEvent(absolute, response.status, text));
    if (!response.ok) throw new Error(`GET ${absolute} failed: ${response.status} ${text.slice(0, 300)}`);
    return text;
  }

  async function fetchJson(url) {
    return JSON.parse(await fetchText(url));
  }

  function readThreads(payload) {
    const threads = [];
    const responses = Array.isArray(payload.responses) ? payload.responses : [];
    for (const response of responses) {
      const addresses = Array.isArray(response.addresses) ? response.addresses : [];
      for (const address of addresses) {
        const addressBook = Array.isArray(address.addressBook) ? address.addressBook : [];
        for (const entry of addressBook) {
          if (!entry.contextValidatorToken) continue;
          threads.push({
            actorId: address.actorId || "",
            actorName: entry.actorName || "",
            actorType: entry.actorType || "",
            contextValidatorToken: entry.contextValidatorToken,
            lastReadMsgTimeStamp: entry.lastReadMsgTimeStamp || 0,
            lastMsgTimeStamp: entry.lastMsgTimeStamp || 0,
            actorLogoURL: entry.actorLogoURL || "",
            communicationStatus: entry.communicationStatus || "",
            membershipType: entry.membershipType || "",
            chatContext: entry.chatContext || ""
          });
        }
      }
    }
    return threads;
  }

  function readNextToken(payload) {
    const responses = Array.isArray(payload.responses) ? payload.responses : [];
    for (const response of responses) {
      const token = response.paginationToken || response.nextToken || response.nextPaginationToken;
      if (token) return token;
    }
    return payload.paginationToken || payload.nextToken || payload.nextPaginationToken || "";
  }

  function isUnreadThread(thread) {
    return Number(thread.lastMsgTimeStamp || 0) > Number(thread.lastReadMsgTimeStamp || 0);
  }

  async function fetchConversation(thread) {
    let paginationToken = "";
    let ok = false;
    for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
      const params = new URLSearchParams({
        actorName: BRAND_ACTOR_NAME,
        contextToken: thread.contextValidatorToken
      });
      if (paginationToken) params.set("paginationToken", paginationToken);
      const url = `/bi/api/chat/messages/list?${params.toString()}`;
      const payload = await fetchJson(url);
      ok = true;
      const nextToken = readNextToken(payload);
      if (!nextToken || nextToken === paginationToken) break;
      paginationToken = nextToken;
      await delay(REQUEST_DELAY_MS);
    }
    return ok;
  }

  async function collectAll() {
    const allThreads = new Map();
    let paginationToken = "";

    for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
      const url = `/bi/api/chat/get?maxSize=100&paginationToken=${encodeURIComponent(paginationToken)}`;
      const payload = await fetchJson(url);
      for (const thread of readThreads(payload)) {
        allThreads.set(thread.contextValidatorToken, thread);
      }

      const nextToken = readNextToken(payload);
      if (!nextToken || nextToken === paginationToken) break;
      paginationToken = nextToken;
      await delay(REQUEST_DELAY_MS);
    }

    const threads = [...allThreads.values()]
      .sort((a, b) => Number(b.lastMsgTimeStamp || 0) - Number(a.lastMsgTimeStamp || 0));
    const unreadThreads = threads.filter(isUnreadThread);

    await emit({
      sourceUrl: location.href,
      frameUrl: location.href,
      type: "bulk-api-status",
      method: "GET",
      url: absoluteUrl("/bi/api/chat/get"),
      status: 200,
      requestBody: "",
      responseText: JSON.stringify({
        message: "collector-started",
        collectorVersion: COLLECTOR_VERSION,
        brandId: BRAND_ID,
        threadsFound: allThreads.size,
        unreadThreadsFound: unreadThreads.length,
        maxAttempts: unreadThreads.length
      })
    });

    let successfulConversations = 0;
    let attemptedConversations = 0;
    for (const thread of unreadThreads) {
      attemptedConversations += 1;
      try {
        const ok = await fetchConversation(thread);
        if (ok) successfulConversations += 1;
      } catch (error) {
        await emit({
          sourceUrl: location.href,
          frameUrl: location.href,
          type: "bulk-api-error",
          method: "GET",
          url: absoluteUrl("/bi/api/chat/messages/list"),
          status: 0,
          requestBody: "",
          responseText: JSON.stringify({
            actorName: thread.actorName,
            contextValidatorToken: thread.contextValidatorToken,
            error: String(error.message || error)
          })
        });
      }
      await delay(REQUEST_DELAY_MS);
    }

    await emit({
      sourceUrl: location.href,
      frameUrl: location.href,
      type: "bulk-api-status",
      method: "GET",
      url: absoluteUrl("/bi/api/chat/messages/list"),
      status: 200,
      requestBody: "",
      responseText: JSON.stringify({
        message: "collector-finished",
        collectorVersion: COLLECTOR_VERSION,
        brandId: BRAND_ID,
        successfulConversations,
        attemptedConversations
      })
    });
  }

  setTimeout(() => {
    collectAll().catch(error => {
      emit({
        sourceUrl: location.href,
        frameUrl: location.href,
        type: "bulk-api-error",
        method: "GET",
        url: location.href,
        status: 0,
        requestBody: "",
        responseText: String(error.message || error)
      });
    });
  }, 1800);
})();
