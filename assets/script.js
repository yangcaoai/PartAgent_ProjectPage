const video = document.querySelector('#method-film');
const steps = Array.from(document.querySelectorAll('.story-step'));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function syncSteps() {
  const activeStep = steps.findLast((step) => video.currentTime >= Number(step.dataset.time));
  for (const step of steps) {
    if (step === activeStep) {
      step.setAttribute('aria-current', 'step');
    } else {
      step.removeAttribute('aria-current');
    }
  }
}

function enableSteps() {
  for (const step of steps) {
    step.disabled = Number(step.dataset.time) >= video.duration;
  }
  syncSteps();
}

function playInView(player) {
  let inView = false;
  let resumeInView = true;

  const observer = new IntersectionObserver(([entry]) => {
    const visible = entry.intersectionRatio >= .25;
    if (inView === visible) return;

    inView = visible;
    if (visible && resumeInView && !reducedMotion.matches) {
      player.play().catch(() => {});
    } else if (!visible) {
      resumeInView = !player.paused;
      if (resumeInView) player.pause();
    }
  }, { threshold: .25 });

  observer.observe(player);
}

for (const step of steps) {
  step.addEventListener('click', () => {
    video.currentTime = Number(step.dataset.time);
    syncSteps();
    video.play().catch(() => {});

    const bounds = video.getBoundingClientRect();
    if (bounds.top < 0 || bounds.bottom > window.innerHeight) {
      video.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'nearest' });
    }
  });
}

video.addEventListener('timeupdate', syncSteps);
video.addEventListener('loadedmetadata', enableSteps);
if (video.readyState >= HTMLMediaElement.HAVE_METADATA) enableSteps();

if (!reducedMotion.matches && 'IntersectionObserver' in window) {
  for (const player of document.querySelectorAll('video[data-autoplay]')) {
    playInView(player);
  }
}
