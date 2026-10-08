// Small shared pieces: modal, markdown, error line.

import { useEffect, type ReactNode } from 'react'
import Markdown from 'react-markdown'

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="x" onClick={onClose} aria-label="Close">×</button></div>
        {children}
      </div>
    </div>
  )
}

export function Md({ text }: { text: string }) {
  const body = text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
  return <div className="md"><Markdown>{body}</Markdown></div>
}

export function Err({ error }: { error: string | null }) {
  return error ? <p className="err">{error}</p> : null
}

export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function readFiles(list: FileList | null): Promise<{ path: string; content: string }[]> {
  return Promise.all([...(list ?? [])].map(f => f.text().then(content => ({ path: f.name, content }))))
}
