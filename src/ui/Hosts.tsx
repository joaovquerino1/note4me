import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { closeDialog, dismissToast, useApp } from '../store'
import { Modal } from './Modal'

export function DialogHost() {
  const dialog = useApp((s) => s.dialog)
  const [value, setValue] = useState('')
  useEffect(() => {
    if (dialog?.kind === 'prompt') setValue(dialog.initial)
  }, [dialog])
  if (!dialog) return null
  if (dialog.kind === 'confirm') {
    const done = (ok: boolean) => {
      closeDialog()
      dialog.resolve(ok)
    }
    return (
      <Modal onClose={() => done(false)} label={dialog.title}>
        <h2>{dialog.title}</h2>
        <p>{dialog.message}</p>
        <div className="dialog-actions">
          <button className="btn" onClick={() => done(false)}>
            Cancelar
          </button>
          <button className={`btn primary ${dialog.danger ? 'danger' : ''}`} data-autofocus onClick={() => done(true)}>
            {dialog.confirmLabel}
          </button>
        </div>
      </Modal>
    )
  }
  const done = (v: string | null) => {
    closeDialog()
    dialog.resolve(v)
  }
  return (
    <Modal onClose={() => done(null)} label={dialog.title}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) done(value.trim())
        }}
      >
        <h2>{dialog.title}</h2>
        <label htmlFor="prompt-input">{dialog.label}</label>
        <input id="prompt-input" type="text" data-autofocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => done(null)}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!value.trim()}>
            {dialog.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function ToastHost() {
  const toasts = useApp((s) => s.toasts)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-kind={t.kind} role={t.kind === 'error' ? 'alert' : undefined}>
          {t.kind === 'error' ? <AlertCircle aria-hidden /> : t.kind === 'success' ? <CheckCircle2 aria-hidden /> : <Info aria-hidden />}
          <div className="toast-body">
            <span className="sr-only">{t.kind === 'error' ? 'Erro: ' : t.kind === 'success' ? 'Concluído: ' : ''}</span>
            {t.message}
            {t.action && (
              <div style={{ marginTop: '0.4rem' }}>
                <button
                  className="btn small"
                  onClick={() => {
                    t.action!.run()
                    dismissToast(t.id)
                  }}
                >
                  {t.action.label}
                </button>
              </div>
            )}
          </div>
          <button className="icon-btn" aria-label="Fechar notificação" onClick={() => dismissToast(t.id)} style={{ width: '1.4rem', height: '1.4rem' }}>
            <X />
          </button>
        </div>
      ))}
    </div>
  )
}
