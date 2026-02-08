import { F1MuseLogo, F1MuseIcon } from "@/components/f1muse-logo"

export default function Page() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Mock header — how the logo looks in a real navbar */}
      <header className="flex items-center justify-between border-b border-white/10 px-6 py-4">
        <F1MuseLogo size="md" />
        <nav className="flex items-center gap-6 text-sm text-gray-400">
          <span>Docs</span>
          <span>Methodology</span>
          <span>GitHub</span>
        </nav>
      </header>

      {/* Showcase grid */}
      <main className="mx-auto flex max-w-4xl flex-col gap-20 px-6 py-20">
        {/* Section: Icon Mark */}
        <section className="flex flex-col items-center gap-8">
          <p className="text-xs font-medium uppercase tracking-widest text-gray-500">
            Icon Mark
          </p>
          <div className="flex items-end gap-10">
            <div className="flex flex-col items-center gap-3">
              <F1MuseIcon size={120} />
              <span className="text-xs text-gray-600">120px</span>
            </div>
            <div className="flex flex-col items-center gap-3">
              <F1MuseIcon size={64} />
              <span className="text-xs text-gray-600">64px</span>
            </div>
            <div className="flex flex-col items-center gap-3">
              <F1MuseIcon size={40} />
              <span className="text-xs text-gray-600">40px</span>
            </div>
            <div className="flex flex-col items-center gap-3">
              <F1MuseIcon size={24} />
              <span className="text-xs text-gray-600">24px</span>
            </div>
          </div>
        </section>

        {/* Section: Full Logo Variants */}
        <section className="flex flex-col items-center gap-8">
          <p className="text-xs font-medium uppercase tracking-widest text-gray-500">
            Full Logo
          </p>
          <div className="flex flex-col items-center gap-8">
            <F1MuseLogo size="lg" />
            <F1MuseLogo size="md" />
            <F1MuseLogo size="sm" />
          </div>
        </section>

        {/* Section: Wordmark Only */}
        <section className="flex flex-col items-center gap-8">
          <p className="text-xs font-medium uppercase tracking-widest text-gray-500">
            Wordmark Only
          </p>
          <div className="flex flex-col items-center gap-6">
            <F1MuseLogo size="lg" showIcon={false} />
            <F1MuseLogo size="md" showIcon={false} />
          </div>
        </section>

        {/* Section: On different backgrounds */}
        <section className="flex flex-col items-center gap-8">
          <p className="text-xs font-medium uppercase tracking-widest text-gray-500">
            Context Preview
          </p>
          <div className="grid w-full grid-cols-2 gap-4">
            {/* Dark card */}
            <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-white/10 bg-[#111111] p-8">
              <F1MuseIcon size={64} />
              <span className="text-xs text-gray-500">Dark surface</span>
            </div>
            {/* Slightly lighter card */}
            <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-white/10 bg-[#1a1a1a] p-8">
              <F1MuseLogo size="md" />
              <span className="text-xs text-gray-500">Card surface</span>
            </div>
            {/* Header-style strip */}
            <div className="col-span-2 flex items-center gap-4 rounded-2xl border border-white/10 bg-[#0d0d0d] px-6 py-4">
              <F1MuseLogo size="sm" />
              <div className="ml-auto flex gap-4 text-xs text-gray-500">
                <span>Link</span>
                <span>Link</span>
                <span>Link</span>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
