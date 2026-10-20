/* Project site behaviour: sticky header, mobile nav, reveals and the gallery
   lightbox. No dependencies, no tracking. */
(() => {
  const header = document.querySelector('.site-header');
  const nav = document.querySelector('#nav');
  const toggle = document.querySelector('.menu-toggle');

  const onScroll = () => {
    header?.classList.toggle('is-scrolled', window.scrollY > 8);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const closeMenu = () => {
    nav?.classList.remove('is-open');
    toggle?.setAttribute('aria-expanded', 'false');
  };

  toggle?.addEventListener('click', () => {
    const open = nav?.classList.toggle('is-open') ?? false;
    toggle.setAttribute('aria-expanded', String(open));
  });

  nav?.addEventListener('click', (event) => {
    if (event.target instanceof HTMLAnchorElement) closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  // Reveal-on-scroll, skipping everything when the visitor prefers less motion.
  // A timer reveals whatever the observer has not seen yet, so a hidden tab, a
  // screenshot tool or an odd viewport can never leave content invisible.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealables = Array.from(document.querySelectorAll('.reveal'));
  const revealAll = () => revealables.forEach((element) => element.classList.add('is-visible'));

  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealAll();
  } else {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 },
    );
    revealables.forEach((element) => observer.observe(element));
    window.setTimeout(revealAll, 2200);
  }

  // Gallery lightbox.
  const dialog = document.querySelector('#lightbox');
  const lightboxImage = document.querySelector('#lightbox-img');
  const lightboxTitle = document.querySelector('#lightbox-title');
  const lightboxCaption = document.querySelector('#lightbox-caption');

  if (dialog instanceof HTMLDialogElement) {
    document.querySelectorAll('.shot').forEach((shot) => {
      shot.addEventListener('click', () => {
        const image = shot.querySelector('img');
        if (!(image instanceof HTMLImageElement)) return;
        if (lightboxImage instanceof HTMLImageElement) {
          lightboxImage.src = image.src;
          lightboxImage.alt = image.alt;
        }
        if (lightboxTitle) lightboxTitle.textContent = shot.dataset.title ?? '';
        if (lightboxCaption) lightboxCaption.textContent = shot.dataset.caption ?? '';
        dialog.showModal();
      });
    });

    dialog.addEventListener('click', (event) => {
      // Clicks on the backdrop (outside the image/caption) close the dialog.
      if (event.target === dialog) dialog.close();
    });
  }
})();
