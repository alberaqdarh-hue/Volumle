import { createWaterAudio } from './assets/water-audio.js';

const $ = (id) => document.getElementById(id);
const profileKey = 'volumle.player.v1';
const settingsKey = 'volumle.settings.v1';
const waterAudio = createWaterAudio();
const feedback = {
  great: [
    ['A seriously good eye.', 'That was a pour to be proud of. Your intuition is in excellent shape.'],
    ['Well, water you know!', 'You absolutely nailed that one. A tiny error, a big win.'],
    ['Consider us impressed.', 'Almost drop for drop. You have a real eye for this.'],
    ['You understood the pour.', 'An outstanding guess. Your inner measuring cup is working beautifully.'],
    ['Precision looks good on you.', 'That is some first-class liquid intuition. Take a little victory sip.'],
    ['A splash of brilliance.', 'So close you could practically count the drops. Beautifully done.'],
  ],
  good: [
    ['A pretty good pour-formance.', 'You were in the right neighborhood. One more pour could be your best.'],
    ['Your eye is warming up.', 'A solid guess. A little fine-tuning and you will be right on the mark.'],
    ['Not too shabby.', 'You got pretty close. There is a good measuring eye in there.'],
    ['You are finding your flow.', 'A respectable guess. Your instincts are headed in the right direction.'],
    ['Close enough to feel it.', 'A decent effort. A few more drops of practice should do it.'],
    ['A little off. A lot of potential.', 'You are getting there. Give that inner measuring cup another go.'],
  ],
  bad: [
    ['That guess took a detour.', 'A little wide of the cup. Your inner measuring jug could use a tune-up.'],
    ['A bit of a splash and miss.', 'That one was quite a way off. Take a closer look on the next pour.'],
    ['The cup has questions.', 'That guess was a stretch. Luckily, there is always another pour.'],
    ['Your measuring eye blinked.', 'A pretty big miss. Shake it off and give your instincts another shot.'],
    ['A drop of wishful thinking.', 'That guess was well off the mark. Even intuition needs a little practice.'],
    ['We might need a bigger guess.', 'Or a smaller one. Either way, that pour deserves another look.'],
  ],
  timeout: [
    ['Time slipped through.', 'The water waited. The clock did not. Take another pour and trust your first instinct.'],
    ['A little too much pondering.', 'No guess this time. Your next flash of intuition is only a pour away.'],
    ['The clock got thirsty.', 'Your 15 seconds are up. Have another go and let your instincts do the talking.'],
  ],
};

function newPlayerId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // getRandomValues also works on ordinary HTTP when playing over a local network.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(profileKey));
    if (saved && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved.id)) {
      return { id: saved.id, name: typeof saved.name === 'string' && saved.name.trim() ? saved.name.slice(0, 24) : 'Guest' };
    }
  } catch { /* A fresh player can still play if browser storage is unavailable. */ }
  const id = newPlayerId();
  return { id, name: `Player ${id.slice(0, 4).toUpperCase()}` };
}

const player = loadProfile();
const settings = loadSettings();
let phase = 'ready';
let round = null;
let attempts = [];
let leaderboard = [];
let stats = { roundsPlayed: 0, bestError: null, averageError: null };
let pendingGuess = null;
let animationFrame = 0;
let clockInterval = 0;
let toastTimeout = 0;
let lastFeedback = '';
let serverClockOffset = 0;
let sessionRevision = 0;

const gameNow = () => Date.now() + serverClockOffset;

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey));
    if (saved && typeof saved === 'object') return {
      theme: saved.theme === 'dark' ? 'dark' : 'light',
      volume: Number.isFinite(saved.volume) ? Math.max(0, Math.min(100, saved.volume)) : 65,
      lastAudibleVolume: Number.isFinite(saved.lastAudibleVolume) && saved.lastAudibleVolume > 0 ? Math.min(100, saved.lastAudibleVolume) : 65,
    };
  } catch { /* Defaults are also usable without browser storage. */ }
  return { theme: 'light', volume: 65, lastAudibleVolume: 65 };
}

function applySettings(persist = true) {
  document.documentElement.dataset.theme = settings.theme;
  document.querySelector('meta[name="theme-color"]').content = settings.theme === 'dark' ? '#101e35' : '#edf8ff';
  $('light-theme').setAttribute('aria-pressed', String(settings.theme === 'light'));
  $('dark-theme').setAttribute('aria-pressed', String(settings.theme === 'dark'));
  $('volume-input').value = settings.volume;
  $('volume-input').setAttribute('aria-valuetext', settings.volume === 0 ? 'Muted' : `${settings.volume} percent`);
  $('volume-output').textContent = `${settings.volume}%`;
  $('volume-icon').setAttribute('href', settings.volume === 0 ? '#i-muted' : '#i-volume');
  $('mute-button').setAttribute('aria-label', settings.volume === 0 ? 'Unmute water sounds' : 'Mute water sounds');
  $('mute-button').setAttribute('aria-pressed', String(settings.volume === 0));
  waterAudio.setVolume(settings.volume / 100);
  if (persist) {
    try { localStorage.setItem(settingsKey, JSON.stringify(settings)); }
    catch { /* Preferences still apply for this visit. */ }
  }
}

function persistProfile() {
  try { localStorage.setItem(profileKey, JSON.stringify(player)); }
  catch { toast('Browser storage is unavailable. Your history may not follow you after a refresh.'); }
}

function renderProfile() {
  $('name-input').value = player.name;
}

function toast(message) {
  clearTimeout(toastTimeout);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 5500);
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The server could not finish this request. Please try again.');
  return data;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function percent(value) {
  if (value === null || value === undefined) return '—';
  if (value > 0 && value < 0.01) return '<0.01';
  return new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(value);
}

function volume(value) {
  return new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(value);
}

function tier(attempt) {
  return attempt.timedOut ? 'timeout' : attempt.errorPercent <= 5 ? 'great' : attempt.errorPercent <= 20 ? 'good' : 'bad';
}

function renderStats() {
  $('rounds-stat').innerHTML = `${stats.roundsPlayed}<span>${stats.roundsPlayed === 1 ? 'round' : 'rounds'}</span>`;
  $('best-stat').innerHTML = `${percent(stats.bestError)}${stats.bestError === null ? '' : '%'}<span>error</span>`;
  $('average-stat').innerHTML = `${percent(stats.averageError)}${stats.averageError === null ? '' : '%'}<span>overall</span>`;
  $('history-count').textContent = stats.roundsPlayed;
  $('history-count').hidden = stats.roundsPlayed === 0;
}

async function refreshSession(silent = false) {
  const requestedAtRevision = sessionRevision;
  try {
    const session = await api(`/api/session?playerId=${encodeURIComponent(player.id)}`);
    if (requestedAtRevision !== sessionRevision || session.stats.roundsPlayed < stats.roundsPlayed) {
      return { attempts, leaderboard, stats };
    }
    attempts = session.attempts;
    leaderboard = session.leaderboard;
    stats = session.stats;
    renderStats();
    return session;
  } catch (error) {
    if (!silent) toast('Could not load your saved rounds. Check that the game server is running.');
    throw error;
  }
}

// The cup tapers. Invert a frustum's volume so the visible amount follows its shape.
function waterGeometry(ratio) {
  const bottomRadius = 80;
  const topRadius = 107;
  const capacity = bottomRadius ** 2 + bottomRadius * (topRadius - bottomRadius) + (topRadius - bottomRadius) ** 2 / 3;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 24; index += 1) {
    const height = (low + high) / 2;
    const partial = bottomRadius ** 2 * height + bottomRadius * (topRadius - bottomRadius) * height ** 2 + (topRadius - bottomRadius) ** 2 * height ** 3 / 3;
    if (partial / capacity < ratio) low = height;
    else high = height;
  }
  const height = (low + high) / 2;
  return { y: 355 - 255 * height, radius: bottomRadius + 27 * height };
}

function setWater(ratio) {
  const { y, radius } = waterGeometry(Math.max(0, Math.min(1, ratio)));
  $('water-body').setAttribute('d', `M110 ${y}H370V385H110Z`);
  $('water-surface').setAttribute('cy', y);
  $('water-surface').setAttribute('rx', radius);
  $('water-surface').setAttribute('ry', 16 + (355 - y) / 255 * 8);
  $('water-ripple').setAttribute('cy', y);
  $('stream-line').setAttribute('d', `M240-110V${y}`);
  $('stream-shine').setAttribute('d', `M238-110V${y}`);
  $('splash-ring').setAttribute('cy', y);
  $('splash-group').setAttribute('transform', `translate(0 ${y})`);
  // The ring is inside the translated impact group, so it stays at its origin.
  $('splash-ring').setAttribute('cy', 0);
  $('pour-stage').style.setProperty('--water-y', `${y}px`);
  $('water-layer').style.opacity = ratio < 0.004 ? '0' : '1';
}

function setTimer(seconds) {
  const safeSeconds = Math.max(0, Math.min(15, seconds));
  $('timer-value').textContent = Math.ceil(safeSeconds);
  $('timer-fill').style.width = `${safeSeconds / 15 * 100}%`;
  $('timer-track').setAttribute('aria-valuenow', Math.ceil(safeSeconds));
  $('timer-track').setAttribute('aria-valuetext', `${Math.ceil(safeSeconds)} seconds remaining`);
  document.querySelector('.timer-block').classList.toggle('urgent', safeSeconds <= 5);
  $('timer-track').classList.toggle('urgent', safeSeconds <= 5);
}

function setMainButton(label, disabled = false) {
  $('main-button-label').textContent = label;
  $('main-button').disabled = disabled;
  $('main-button').querySelector('.drop-icon').hidden = phase === 'guessing';
}

function clearError() {
  $('form-error').hidden = true;
  $('form-error').textContent = '';
  $('guess-input').removeAttribute('aria-invalid');
}

function stopClock() {
  clearInterval(clockInterval);
  cancelAnimationFrame(animationFrame);
  waterAudio.stop();
}

async function startRound() {
  if (!['ready', 'result'].includes(phase)) return;
  // Unlock audio inside the user's click/Enter gesture, before the API request.
  const audioReady = waterAudio.unlock();
  phase = 'starting';
  stopClock();
  clearError();
  $('play-panel').hidden = false;
  $('result-panel').hidden = true;
  $('reveal-tag').hidden = true;
  $('guess-input').value = '';
  $('guess-input').disabled = true;
  $('save-restart')?.remove();
  $('round-status').textContent = 'A FRESH START';
  $('pour-stage').className = 'pour-stage';
  setMainButton('Getting your pour ready…', true);
  setTimer(15);
  try {
    const requestStartedAt = Date.now();
    round = await api('/api/rounds', { playerId: player.id });
    if (Number.isFinite(round.serverNow)) serverClockOffset = round.serverNow - (requestStartedAt + Date.now()) / 2;
    phase = 'pouring';
    $('pour-stage').classList.add('pouring');
    $('round-status').textContent = 'Water is pouring. Your 15 seconds begin when it stops.';
    $('timer-label').textContent = 'Your countdown starts after the pour';
    $('cup-title').textContent = 'Water is pouring into a one-liter cup. Estimate the amount visually.';
    setMainButton('Pouring…', true);
    setWater(0);
    const pourStartedAt = round.startsAt - round.pourDurationMs;
    void audioReady.then((ready) => {
      if (!ready || phase !== 'pouring' || document.hidden) return;
      const progress = Math.max(0, Math.min(1, (gameNow() - pourStartedAt) / round.pourDurationMs));
      waterAudio.start(Math.max(0, round.startsAt - gameNow()), progress);
    });
    const animate = () => {
      if (phase !== 'pouring') return;
      const progress = Math.max(0, Math.min(1, (gameNow() - pourStartedAt) / round.pourDurationMs));
      const easedProgress = progress * progress * (3 - 2 * progress);
      setWater(round.fillRatio * easedProgress);
      $('pour-stream').setAttribute('opacity', progress > 0.97 ? 0 : Math.min(1, 0.35 + progress * 12));
      if (gameNow() >= round.startsAt) beginGuessing();
      else animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);
    // Timers also run when animation frames are paused in a background tab.
    clockInterval = setInterval(tick, 80);
  } catch (error) {
    phase = 'ready';
    $('round-status').textContent = 'LET’S TRY THAT AGAIN';
    stopClock();
    setMainButton('Try starting again');
    toast(error.message === 'Failed to fetch' ? 'Could not connect to the game server. Please try again.' : error.message);
  }
}

function beginGuessing() {
  if (phase !== 'pouring') return;
  phase = 'guessing';
  waterAudio.stop();
  cancelAnimationFrame(animationFrame);
  setWater(round.fillRatio);
  $('pour-stream').setAttribute('opacity', 0);
  $('pour-stage').classList.remove('pouring');
  $('pour-stage').classList.add('guessing');
  $('cup-title').textContent = 'A one-liter cup partly filled with water. Guess the amount in milliliters.';
  $('round-status').textContent = 'The pour is done. You have 15 seconds to guess in milliliters.';
  $('timer-label').textContent = 'Time left to make your guess';
  $('guess-input').disabled = false;
  setMainButton('Lock in my guess');
  if (!document.querySelector('dialog[open]') && gameNow() < round.deadline) $('guess-input').focus({ preventScroll: true });
  tick();
}

function tick() {
  if (phase === 'pouring' && gameNow() >= round.startsAt) beginGuessing();
  if (phase !== 'guessing') return;
  const seconds = Math.max(0, (round.deadline - gameNow()) / 1000);
  setTimer(seconds);
  if (seconds <= 0) void submitGuess(null);
}

async function submitGuess(guessMl) {
  if (!['guessing', 'save-error'].includes(phase)) return;
  phase = 'submitting';
  stopClock();
  clearError();
  $('save-restart')?.remove();
  pendingGuess = guessMl;
  $('guess-input').disabled = true;
  $('round-status').textContent = 'THE MOMENT OF TRUTH';
  setMainButton('Saving your pour…', true);
  try {
    const result = await api('/api/guesses', { roundId: round.id, playerId: player.id, playerName: player.name, guessMl });
    acceptResult(result);
  } catch (error) {
    // The response may have been lost after the server safely saved the guess.
    try {
      const session = await refreshSession(true);
      const savedAttempt = session.attempts.find((attempt) => attempt.roundId === round.id);
      if (savedAttempt) {
        acceptResult({ attempt: savedAttempt, stats: session.stats, leaderboard: session.leaderboard });
        return;
      }
    } catch { /* Show an honest retry state if the server remains unreachable. */ }
    phase = 'save-error';
    $('round-status').textContent = 'YOUR RESULT IS NOT SAVED YET';
    $('form-error').textContent = `Could not save your guess. ${error.message}`;
    $('form-error').hidden = false;
    setMainButton('Retry saving result');
    if (!$('save-restart')) {
      const restart = document.createElement('button');
      restart.id = 'save-restart';
      restart.type = 'button';
      restart.className = 'secondary-button';
      restart.textContent = 'Leave this round and start a fresh pour';
      restart.addEventListener('click', () => {
        if (phase !== 'save-error') return;
        phase = 'ready';
        void startRound();
      });
      $('play-panel').append(restart);
    }
  }
}

function acceptResult(result) {
  sessionRevision += 1;
  if (!attempts.some((attempt) => attempt.id === result.attempt.id)) attempts.unshift(result.attempt);
  attempts = attempts.slice(0, 50);
  stats = result.stats;
  leaderboard = result.leaderboard;
  phase = 'result';
  stopClock();
  $('pour-stage').className = 'pour-stage result';
  $('pour-stream').setAttribute('opacity', 0);
  $('reveal-volume').innerHTML = `${volume(result.attempt.actualMl)} <small>ml</small>`;
  $('reveal-tag').hidden = false;
  $('cup-title').textContent = `The cup contained ${result.attempt.actualMl} milliliters of water.`;
  renderStats();
  renderResult(result.attempt);
}

function renderResult(attempt) {
  const performance = tier(attempt);
  const messages = feedback[performance].filter(([message]) => message !== lastFeedback);
  const [message, subtitle] = messages[Math.floor(Math.random() * messages.length)];
  lastFeedback = message;
  const labels = { great: 'A MEASURE OF BRILLIANCE', good: 'GETTING INTO THE FLOW', bad: 'ROOM FOR ANOTHER POUR', timeout: 'TIME’S UP' };
  const difference = attempt.timedOut ? '' : attempt.guessMl - attempt.actualMl;
  const detail = attempt.timedOut ? 'No guess was submitted before the timer ended.' : difference === 0 ? 'Exactly right. Every single milliliter.' : `${volume(Math.abs(difference))} ml ${difference > 0 ? 'over' : 'under'} the actual pour.`;
  $('result-panel').className = `result-${performance}`;
  $('result-panel').innerHTML = `
    <div class="result-kicker"><span class="performance-pill"><svg class="icon"><use href="#i-${performance === 'timeout' ? 'clock' : 'spark'}"/></svg>${labels[performance]}</span></div>
    <h2 class="result-message">${message}</h2><p class="result-subtitle">${subtitle}</p>
    <div class="error-score"><strong>${attempt.timedOut ? 'Time’s up' : `${percent(attempt.errorPercent)}<small>%</small>`}</strong><span>${attempt.timedOut ? 'let’s try again' : 'error · closer to 0% is better'}</span></div>
    <div class="comparison-grid"><div class="comparison-cell"><span>Your estimate</span><strong>${attempt.timedOut ? '—' : volume(attempt.guessMl)}${attempt.timedOut ? '' : '<small>ml</small>'}</strong></div><div class="comparison-cell actual"><span>The actual pour</span><strong>${volume(attempt.actualMl)}<small>ml</small></strong></div></div>
    <p class="result-detail">${detail}</p>
    <button class="primary-button" id="pour-again" type="button"><svg class="icon drop-icon"><use href="#i-drop"/></svg>Pour again<svg class="icon button-arrow"><use href="#i-arrow"/></svg></button>
    <button class="secondary-button" id="result-history" type="button">View history</button>`;
  $('play-panel').hidden = true;
  $('result-panel').hidden = false;
  $('pour-again').addEventListener('click', startRound);
  $('result-history').addEventListener('click', openHistory);
  $('pour-again').focus({ preventScroll: true });
}

function renderHistory() {
  if (!attempts.length) {
    $('history-content').innerHTML = '<div class="empty-state"><svg class="icon"><use href="#i-history"/></svg><strong>Your first pour is waiting.</strong><p>Play a round and your guess will appear here.<br>Every little improvement starts somewhere.</p></div>';
    return;
  }
  const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('history-content').innerHTML = `<div class="history-table-wrap"><table class="history-table"><thead><tr><th scope="col">When</th><th scope="col">Your guess</th><th scope="col">Actual</th><th scope="col">Error</th></tr></thead><tbody>${attempts.map((attempt) => `<tr><td>${escapeHtml(date.format(new Date(attempt.createdAt)))}</td><td>${attempt.timedOut ? 'No guess' : `${volume(attempt.guessMl)} ml`}</td><td>${volume(attempt.actualMl)} ml</td><td><span class="error-pill ${tier(attempt)}">${attempt.timedOut ? 'Timed out' : `${percent(attempt.errorPercent)}%`}</span></td></tr>`).join('')}</tbody></table></div>`;
}

function renderLeaderboard() {
  if (!leaderboard.length) {
    $('board-content').innerHTML = '<div class="empty-state"><svg class="icon"><use href="#i-trophy"/></svg><strong>The top spot is open.</strong><p>Make a guess to be the first on the pour board.<br>Other players on this server can join you here.</p></div>';
    return;
  }
  $('board-content').innerHTML = leaderboard.map((entry, index) => `<div class="leaderboard-row ${entry.playerId === player.id ? 'is-you' : ''}"><span class="leader-rank">${index === 0 ? '♔' : String(index + 1).padStart(2, '0')}</span><span class="leader-avatar">${escapeHtml(entry.playerName.charAt(0).toUpperCase())}</span><div class="leader-details"><strong>${escapeHtml(entry.playerName)}${entry.playerId === player.id ? ' <span class="you-marker">(you)</span>' : ''}</strong><small>${entry.roundsPlayed} ${entry.roundsPlayed === 1 ? 'round' : 'rounds'} played · Best: ${volume(entry.guessMl)} / ${volume(entry.actualMl)} ml</small></div><span class="leader-error">${percent(entry.errorPercent)}%<small>error</small></span></div>`).join('');
}

async function openHistory() {
  renderHistory();
  $('history-dialog').showModal();
  try { await refreshSession(); renderHistory(); }
  catch { /* The last loaded history remains available. */ }
}

async function openBoard() {
  renderLeaderboard();
  $('board-dialog').showModal();
  try { await refreshSession(); renderLeaderboard(); }
  catch { /* The last loaded board remains available. */ }
}

$('guess-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (phase === 'ready') { void startRound(); return; }
  if (phase === 'save-error') { void submitGuess(pendingGuess); return; }
  if (phase !== 'guessing') return;
  if (gameNow() >= round.deadline) { tick(); return; }
  const raw = $('guess-input').value.trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0 || value > 1000) {
    $('form-error').textContent = 'Enter an amount greater than 0 and no more than 1,000 ml.';
    $('form-error').hidden = false;
    $('guess-input').setAttribute('aria-invalid', 'true');
    $('guess-input').focus({ preventScroll: true });
    return;
  }
  void submitGuess(value);
});
$('guess-input').addEventListener('input', clearError);
$('history-nav').addEventListener('click', openHistory);
$('board-button').addEventListener('click', openBoard);
$('how-nav').addEventListener('click', () => $('how-dialog').showModal());
$('settings-button').addEventListener('click', () => {
  $('name-input').value = player.name;
  $('settings-dialog').showModal();
});
$('light-theme').addEventListener('click', () => { settings.theme = 'light'; applySettings(); });
$('dark-theme').addEventListener('click', () => { settings.theme = 'dark'; applySettings(); });
$('volume-input').addEventListener('input', () => {
  settings.volume = Number($('volume-input').value);
  if (settings.volume > 0) settings.lastAudibleVolume = settings.volume;
  applySettings();
});
$('mute-button').addEventListener('click', () => {
  settings.volume = settings.volume === 0 ? settings.lastAudibleVolume : 0;
  applySettings();
});
$('test-sound').addEventListener('click', async () => {
  if (settings.volume === 0) { toast('Turn up the volume to hear the water.'); return; }
  const ready = await waterAudio.unlock();
  if (!ready) { toast('Sound is unavailable in this browser.'); return; }
  if (!$('settings-dialog').open || document.hidden) return;
  if (phase !== 'pouring') waterAudio.start(1400);
});
$('settings-dialog').addEventListener('close', () => { if (phase !== 'pouring') waterAudio.stop(); });
$('profile-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('name-input').value.replace(/\s+/g, ' ').trim();
  if (!name || name.length > 24) { $('name-input').setCustomValidity('Choose a name between 1 and 24 characters.'); $('name-input').reportValidity(); return; }
  player.name = name;
  persistProfile();
  renderProfile();
  toast(`Player name saved: ${name}`);
});
$('name-input').addEventListener('input', () => $('name-input').setCustomValidity(''));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
  });
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) waterAudio.stop();
  else tick();
});
window.addEventListener('pagehide', (event) => {
  waterAudio.stop();
  if (!event.persisted) void waterAudio.dispose();
});

renderProfile();
persistProfile();
renderStats();
applySettings(false);
setWater(0.48);
void refreshSession().catch(() => {});
