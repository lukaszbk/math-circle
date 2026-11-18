import { escapeHtml } from './utils.js';

/**
 * Opens a touch-first numeric PIN pad modal inside #modal-root.
 * Supports mouse/touch taps AND physical keyboard digits, Backspace, Enter, Escape.
 */
export function openPinModal({
  title,
  subtitle = '',
  pinLength = 4,
  verifyFn,
  onSuccess,
  onCancel
}) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  let entered = '';
  let busy = false;
  let closed = false;
  let errorMsg = '';
  let shake = false;

  const cleanup = () => {
    closed = true;
    document.removeEventListener('keydown', onKeyDown);
    modalRoot.innerHTML = '';
  };

  const submitPin = async () => {
    if (closed || busy || entered.length !== pinLength) return;
    busy = true;
    errorMsg = '';
    render();
    try {
      const result = await verifyFn(entered);
      if (closed) return;
      if (result && result.ok) {
        const verifiedPin = entered;
        busy = false;
        cleanup();
        onSuccess(verifiedPin, result);
        return;
      }
      errorMsg = (result && result.error) || 'Incorrect PIN. Please try again.';
      entered = '';
      shake = true;
    } catch (err) {
      if (closed) return;
      errorMsg = err?.message || 'Connection error. Please try again.';
      entered = '';
      shake = true;
    }
    busy = false;
    render();
    shake = false;
  };

  const pushDigit = (digit) => {
    if (busy || entered.length >= pinLength) return;
    errorMsg = '';
    entered += digit;
    render();
    if (entered.length === pinLength) {
      window.setTimeout(() => submitPin(), 90);
    }
  };

  const backspace = () => {
    if (busy || entered.length === 0) return;
    errorMsg = '';
    entered = entered.slice(0, -1);
    render();
  };

  const clearAll = () => {
    if (busy) return;
    errorMsg = '';
    entered = '';
    render();
  };

  const cancel = () => {
    cleanup();
    if (onCancel) onCancel();
  };

  const onKeyDown = (ev) => {
    if (ev.key >= '0' && ev.key <= '9') {
      ev.preventDefault();
      pushDigit(ev.key);
    } else if (ev.key === 'Backspace') {
      ev.preventDefault();
      backspace();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      submitPin();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel();
    }
  };

  document.addEventListener('keydown', onKeyDown);

  const render = () => {
    if (closed) return;
    const dots = Array.from({ length: pinLength }, (_, idx) => {
      const filled = idx < entered.length ? 'filled' : '';
      return `<span class="pin-dot ${filled}" aria-hidden="true"></span>`;
    }).join('');

    modalRoot.innerHTML = `
      <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="modal-card">
          <div class="modal-head">
            <div>
              <h3>${escapeHtml(title)}</h3>
              ${subtitle ? `<p class="brand-subtitle">${escapeHtml(subtitle)}</p>` : ''}
            </div>
            <button type="button" class="btn btn-ghost btn-sm" data-action="cancel" aria-label="Close">✕</button>
          </div>

          <div class="pin-dots ${shake ? 'shake' : ''}" aria-label="${entered.length} of ${pinLength} digits entered">
            ${dots}
          </div>

          <div class="pin-error" role="alert">${busy ? 'Checking PIN…' : escapeHtml(errorMsg)}</div>

          <div class="keypad-grid">
            ${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(
              (d) => `<button type="button" class="keypad-btn" data-digit="${d}" ${busy ? 'disabled' : ''}>${d}</button>`
            ).join('')}
            <button type="button" class="keypad-btn action-text" data-action="clear" ${busy ? 'disabled' : ''}>Clear</button>
            <button type="button" class="keypad-btn" data-digit="0" ${busy ? 'disabled' : ''}>0</button>
            <button type="button" class="keypad-btn action-text" data-action="backspace" aria-label="Backspace" ${busy ? 'disabled' : ''}>⌫</button>
          </div>
        </div>
      </div>
    `;

    modalRoot.querySelectorAll('[data-digit]').forEach((btn) => {
      btn.addEventListener('click', () => pushDigit(btn.dataset.digit));
    });
    modalRoot.querySelector('[data-action="clear"]')?.addEventListener('click', clearAll);
    modalRoot.querySelector('[data-action="backspace"]')?.addEventListener('click', backspace);
    modalRoot.querySelector('[data-action="cancel"]')?.addEventListener('click', cancel);
    modalRoot.querySelector('.modal-backdrop')?.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('modal-backdrop')) {
        cancel();
      }
    });
  };

  render();
}
