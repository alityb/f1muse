import { ImageResponse } from 'next/og'

export const runtime = 'edge'

export const size = {
  width: 180,
  height: 180,
}
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0a',
          borderRadius: '22%',
        }}
      >
        <svg
          width="120"
          height="120"
          viewBox="0 0 64 64"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Top slash — shortest, brightest */}
          <polygon points="26,8 46,8 40,20 20,20" fill="#ffffff" />
          {/* Middle slash — medium, slightly dimmer */}
          <polygon points="18,26 50,26 44,38 12,38" fill="#d1d5db" />
          {/* Bottom slash — widest, darkest */}
          <polygon points="10,44 54,44 48,56 4,56" fill="#9ca3af" />
        </svg>
      </div>
    ),
    {
      ...size,
    }
  )
}
