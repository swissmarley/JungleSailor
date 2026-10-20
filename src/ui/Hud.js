// Minimal interface: distance counter, weather and sound toggles, fullscreen,
// and a control hint that fades once the player gets going.
export class Hud {
  constructor({ weather, audio, touch }) {
    this.weather = weather;
    this.audio = audio;
    this.distanceEl = document.getElementById('distance');
    this.lotusEl = document.getElementById('lotus');
    this.lotusCountEl = document.getElementById('lotus-count');
    this.lotus = 0;
    this.hintEl = document.getElementById('hint');
    this.soundEl = document.getElementById('sound');
    this.fullscreenEl = document.getElementById('fullscreen');
    this.weatherButtons = [...document.querySelectorAll('[data-weather]')];
    this.lastText = '';
    this.hintTimer = null;

    for (const btn of this.weatherButtons) {
      btn.addEventListener('click', () => weather.set(btn.dataset.weather));
    }
    weather.onChange((name) => this.showWeather(name));
    this.showWeather(weather.name);

    this.soundEl.addEventListener('click', () => this.toggleSound());

    const root = document.documentElement;
    const canFullscreen = document.fullscreenEnabled || document.webkitFullscreenEnabled;
    if (canFullscreen) {
      this.fullscreenEl.hidden = false;
      this.fullscreenEl.addEventListener('click', () => {
        const active = document.fullscreenElement || document.webkitFullscreenElement;
        if (active) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        else (root.requestFullscreen || root.webkitRequestFullscreen).call(root, { navigationUI: 'hide' });
      });
    }

    // 1 / 2 / 3 pick the weather, M toggles sound.
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const map = { Digit1: 'night', Digit2: 'dawn', Digit3: 'rain' };
      if (map[e.code]) weather.set(map[e.code]);
      if (e.code === 'KeyM') this.toggleSound();
    });

    // Pointer clicks should not leave focus on a button: steering keys would
    // then show its focus ring and Space would re-trigger it. Keyboard users
    // (detail === 0) keep their focus.
    for (const btn of document.querySelectorAll('.hud button')) {
      btn.addEventListener('click', (e) => {
        if (e.detail > 0) btn.blur();
      });
    }

    this.setHint(touch);
  }

  setHint(touch) {
    this.hintEl.innerHTML = touch
      ? 'Drag up to paddle, sideways to steer'
      : '<kbd>W</kbd> paddle · <kbd>A</kbd><kbd>D</kbd> steer · <kbd>S</kbd> back-paddle';
  }

  // Called on the first real input; the hint lingers briefly, then fades.
  nudge() {
    if (this.hintTimer !== null) return;
    this.hintTimer = setTimeout(() => this.hintEl.classList.add('hidden'), 4500);
  }

  showWeather(name) {
    for (const btn of this.weatherButtons) btn.setAttribute('aria-pressed', String(btn.dataset.weather === name));
  }

  async toggleSound() {
    if (this.audio.enabled) {
      this.audio.disable();
      this.soundEl.setAttribute('aria-pressed', 'false');
    } else {
      this.soundEl.setAttribute('aria-pressed', 'true');
      try {
        await this.audio.enable();
      } catch (err) {
        console.warn('Audio could not start', err);
        this.soundEl.setAttribute('aria-pressed', 'false');
      }
    }
  }

  setLotus(count) {
    if (count === this.lotus) return;
    this.lotus = count;
    this.lotusCountEl.textContent = String(count);
    this.lotusEl.classList.remove('pulse');
    void this.lotusEl.offsetWidth; // restart the animation
    this.lotusEl.classList.add('pulse');
  }

  setDistance(metres) {
    metres = Math.max(0, metres);
    const text = metres < 1000 ? `${Math.floor(metres)} m` : `${(metres / 1000).toFixed(2)} km`;
    if (text !== this.lastText) {
      this.distanceEl.textContent = text;
      this.lastText = text;
    }
  }
}
