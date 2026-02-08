"use client"

export function F1MuseLogo({ size = 28 }: { size?: number }) {
  // A precision grid mark: 3x3 dot grid where one dot (bottom-right)
  // is offset diagonally — evoking "data with intent"
  const dotSize = size * 0.1
  const gap = size * 0.28
  const offset = size * 0.06

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="F1Muse logo"
    >
      {/* 3x3 grid of dots */}
      {[0, 1, 2].map((row) =>
        [0, 1, 2].map((col) => {
          const isAccent = row === 2 && col === 2
          const cx = size * 0.2 + col * gap + (isAccent ? offset : 0)
          const cy = size * 0.2 + row * gap + (isAccent ? offset : 0)
          return (
            <circle
              key={`${row}-${col}`}
              cx={cx}
              cy={cy}
              r={isAccent ? dotSize * 1.3 : dotSize}
              fill={isAccent ? "hsl(0 0% 98%)" : "hsl(0 0% 45%)"}
            />
          )
        })
      )}
    </svg>
  )
}

export function F1MuseWordmark() {
  return (
    <span className="flex items-center gap-2">
      <F1MuseLogo size={24} />
      <span className="text-foreground text-sm font-medium tracking-tight">
        F1Muse
      </span>
    </span>
  )
}
