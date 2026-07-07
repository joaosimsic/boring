export const GPT_INJECT_SCRIPT = `
window.__gptEvents = [];

(function() {
  var check = setInterval(function() {
    if (window.googletag && window.googletag.pubads && typeof window.googletag.pubads().addEventListener === 'function') {
      window.googletag.pubads().addEventListener('slotRenderEnded', function(event) {
        window.__gptEvents.push({
          slotName: event.slot ? event.slot.getSlotElementId() : 'unknown',
          size: event.size,
          lineItemId: event.lineItemId,
          creativeId: event.creativeId,
          isEmpty: event.isEmpty,
          timestamp: Date.now()
        });
      });
      clearInterval(check);
    }
  }, 1);
})();
`;
