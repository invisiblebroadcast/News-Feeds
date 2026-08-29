// PWA install banner: shows a download icon + prompt at the top on mobile
// when the browser fires beforeinstallprompt.
(function () {
  let deferredPrompt = null;
  let bannerShown = false;

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  function isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }

  function hideBanner() {
    const banner = document.getElementById('pwa-install-banner');
    if (banner) banner.classList.remove('show');
    try { localStorage.setItem('pwa-install-dismissed', '1'); } catch {}
  }

  function showBanner() {
    if (bannerShown) return;
    if (isStandalone()) return;
    if (!isMobile()) return;
    try {
      if (localStorage.getItem('pwa-install-dismissed') === '1') return;
    } catch {}

    const banner = document.getElementById('pwa-install-banner');
    if (!banner) return;

    bannerShown = true;
    banner.classList.add('show');
  }

  async function doInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        hideBanner();
        try { localStorage.setItem('pwa-install-accepted', '1'); } catch {}
      }
    } catch (e) {}
    deferredPrompt = null;
  }

  function init() {
    if (isStandalone()) return;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      showBanner();
    });

    const banner = document.getElementById('pwa-install-banner');
    if (banner) {
      banner.querySelector('.pwa-install-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        doInstall();
      });
      banner.querySelector('.pwa-install-close')?.addEventListener('click', (e) => {
        e.preventDefault();
        hideBanner();
      });
    }

    // If appinstalled fires, clean up
    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      hideBanner();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
