export const GPT_INJECT_SCRIPT = `
window.__gptEvents = [];

(function() {
  var check = setInterval(function() {
    if (window.googletag && window.googletag.pubads && typeof window.googletag.pubads().addEventListener === 'function') {
      window.googletag.pubads().addEventListener('slotRenderEnded', function(event) {
        var slot = event.slot;
        var adUnitPath = '';
        try {
          if (slot && typeof slot.getAdUnitPath === 'function') adUnitPath = slot.getAdUnitPath();
        } catch (e) {}
        window.__gptEvents.push({
          slot: slot ? slot.getSlotElementId() : 'unknown',
          adUnitPath: adUnitPath,
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