interface F1MuseLogoProps {
  variant?: 'icon' | 'horizontal' | 'stacked';
  size?: number;
  theme?: 'light' | 'dark';
}

export function F1MuseLogo({ 
  variant = 'horizontal', 
  size = 200,
  theme = 'light' 
}: F1MuseLogoProps) {
  const orangeColor = '#FF7A18';
  const darkColor = theme === 'light' ? '#1a1a1a' : '#ffffff';
  
  // Icon SVG - checkered flag in rounded container with motion
  const LogoIcon = ({ iconSize }: { iconSize: number }) => (
    <svg 
      width={iconSize} 
      height={iconSize} 
      viewBox="0 0 100 100" 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Rounded container */}
      <rect 
        width="100" 
        height="100" 
        rx="22" 
        fill={orangeColor}
      />
      
      {/* Abstract checkered flag - diagonal tilt for speed */}
      <g transform="translate(25, 30) rotate(-8, 25, 20)">
        {/* First row */}
        <rect x="0" y="0" width="10" height="8" fill="white" />
        <rect x="10" y="0" width="10" height="8" fill="#1a1a1a" />
        <rect x="20" y="0" width="10" height="8" fill="white" />
        <rect x="30" y="0" width="10" height="8" fill="#1a1a1a" />
        <rect x="40" y="0" width="10" height="8" fill="white" />
        
        {/* Second row */}
        <rect x="0" y="8" width="10" height="8" fill="#1a1a1a" />
        <rect x="10" y="8" width="10" height="8" fill="white" />
        <rect x="20" y="8" width="10" height="8" fill="#1a1a1a" />
        <rect x="30" y="8" width="10" height="8" fill="white" />
        <rect x="40" y="8" width="10" height="8" fill="#1a1a1a" />
        
        {/* Third row */}
        <rect x="0" y="16" width="10" height="8" fill="white" />
        <rect x="10" y="16" width="10" height="8" fill="#1a1a1a" />
        <rect x="20" y="16" width="10" height="8" fill="white" />
        <rect x="30" y="16" width="10" height="8" fill="#1a1a1a" />
        <rect x="40" y="16" width="10" height="8" fill="white" />
        
        {/* Fourth row */}
        <rect x="0" y="24" width="10" height="8" fill="#1a1a1a" />
        <rect x="10" y="24" width="10" height="8" fill="white" />
        <rect x="20" y="24" width="10" height="8" fill="#1a1a1a" />
        <rect x="30" y="24" width="10" height="8" fill="white" />
        <rect x="40" y="24" width="10" height="8" fill="#1a1a1a" />
        
        {/* Fifth row */}
        <rect x="0" y="32" width="10" height="8" fill="white" />
        <rect x="10" y="32" width="10" height="8" fill="#1a1a1a" />
        <rect x="20" y="32" width="10" height="8" fill="white" />
        <rect x="30" y="32" width="10" height="8" fill="#1a1a1a" />
        <rect x="40" y="32" width="10" height="8" fill="white" />
      </g>
      
      {/* Motion lines for speed effect */}
      <line x1="10" y1="25" x2="2" y2="25" stroke="white" strokeWidth="2.5" strokeLinecap="round" opacity="0.6" />
      <line x1="10" y1="35" x2="4" y2="35" stroke="white" strokeWidth="2.5" strokeLinecap="round" opacity="0.4" />
      <line x1="10" y1="45" x2="2" y2="45" stroke="white" strokeWidth="2.5" strokeLinecap="round" opacity="0.6" />
      <line x1="10" y1="55" x2="4" y2="55" stroke="white" strokeWidth="2.5" strokeLinecap="round" opacity="0.4" />
      <line x1="10" y1="65" x2="2" y2="65" stroke="white" strokeWidth="2.5" strokeLinecap="round" opacity="0.6" />
      <line x1="10" y1="75" x2="4" y2="75" stroke="white" strokeWidth="2.5" strokeLinecap="round" opacity="0.4" />
    </svg>
  );

  // Wordmark SVG - geometric sans-serif style
  const Wordmark = ({ wordmarkSize }: { wordmarkSize: number }) => (
    <svg 
      width={wordmarkSize * 3.5} 
      height={wordmarkSize} 
      viewBox="0 0 280 80" 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg"
    >
      <text
        x="0"
        y="60"
        fill={darkColor}
        style={{
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "SF Pro Display", sans-serif',
          fontSize: '64px',
          fontWeight: '600',
          letterSpacing: '-0.02em'
        }}
      >
        f1muse
      </text>
    </svg>
  );

  if (variant === 'icon') {
    return <LogoIcon iconSize={size} />;
  }

  if (variant === 'horizontal') {
    const iconSize = size * 0.4;
    const wordmarkSize = size * 0.32;
    
    return (
      <div className="flex items-center gap-4">
        <LogoIcon iconSize={iconSize} />
        <Wordmark wordmarkSize={wordmarkSize} />
      </div>
    );
  }

  if (variant === 'stacked') {
    const iconSize = size * 0.5;
    const wordmarkSize = size * 0.25;
    
    return (
      <div className="flex flex-col items-center gap-4">
        <LogoIcon iconSize={iconSize} />
        <Wordmark wordmarkSize={wordmarkSize} />
      </div>
    );
  }

  return null;
}
