"use client"

export function StatusBar() {
  return (
    <footer className="fixed bottom-0 left-0 right-0 flex items-center justify-between px-6 py-2 border-t border-border/30 bg-background/90 backdrop-blur-sm z-10">
      <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground/40">
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 bg-emerald-500/60" aria-hidden="true" />
          <span>connected</span>
        </span>
        <span className="w-px h-3 bg-border/30" aria-hidden="true" />
        <span>
          data from{" "}
          <a
            href="https://github.com/theOehrly/Fast-F1"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-muted-foreground/70 transition-colors underline underline-offset-2"
          >
            FastF1
          </a>
          {" & "}
          <a
            href="https://github.com/f1db/f1db"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-muted-foreground/70 transition-colors underline underline-offset-2"
          >
            F1DB
          </a>
        </span>
      </div>
      <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground/40">
        <span>All answers computed from validated SQL templates</span>
      </div>
    </footer>
  )
}
