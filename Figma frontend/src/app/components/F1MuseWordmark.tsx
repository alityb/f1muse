interface F1MuseWordmarkProps {
  size?: 'sm' | 'md' | 'lg';
  theme?: 'light' | 'dark';
}

export function F1MuseWordmark({ size = 'md', theme = 'dark' }: F1MuseWordmarkProps) {
  const sizeMap = {
    sm: '18px',
    md: '22px',
    lg: '28px',
  };

  const color = theme === 'dark' ? '#ffffff' : '#000000';

  return (
    <div 
      style={{
        fontSize: sizeMap[size],
        fontWeight: '700',
        letterSpacing: '-0.03em',
        color: color,
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
      }}
    >
      f1muse
    </div>
  );
}
