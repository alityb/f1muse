export const teamGradients = {
  ferrari: {
    primary: '#E80020',
    secondary: '#000000',
    accent: '#FFF200',
    gradient: 'linear-gradient(165deg, #E80020 0%, #C50019 35%, #8B0000 65%, #000000 100%)',
    imageGradient: 'linear-gradient(to top, #E80020 0%, rgba(232, 0, 32, 0.85) 25%, rgba(232, 0, 32, 0.4) 50%, transparent 100%)',
    sideGradient: 'linear-gradient(to right, rgba(232, 0, 32, 0.6) 0%, rgba(232, 0, 32, 0.3) 30%, transparent 60%)',
    glowColor: 'rgba(232, 0, 32, 0.5)',
  },
  redbull: {
    primary: '#0600EF',
    secondary: '#DC0000',
    accent: '#FCD700',
    gradient: 'linear-gradient(165deg, #0600EF 0%, #1B1464 40%, #6C1D45 70%, #DC0000 100%)',
    imageGradient: 'linear-gradient(to top, #0600EF 0%, rgba(6, 0, 239, 0.85) 25%, rgba(6, 0, 239, 0.4) 50%, transparent 100%)',
    sideGradient: 'linear-gradient(to right, rgba(6, 0, 239, 0.6) 0%, rgba(6, 0, 239, 0.3) 30%, transparent 60%)',
    glowColor: 'rgba(6, 0, 239, 0.5)',
  },
  mercedes: {
    primary: '#00D2BE',
    secondary: '#000000',
    accent: '#C0C0C0',
    gradient: 'linear-gradient(165deg, #00D2BE 0%, #00A896 35%, #006B5D 65%, #000000 100%)',
    imageGradient: 'linear-gradient(to top, #00D2BE 0%, rgba(0, 210, 190, 0.85) 25%, rgba(0, 210, 190, 0.4) 50%, transparent 100%)',
    sideGradient: 'linear-gradient(to right, rgba(0, 210, 190, 0.6) 0%, rgba(0, 210, 190, 0.3) 30%, transparent 60%)',
    glowColor: 'rgba(0, 210, 190, 0.5)',
  },
  mclaren: {
    primary: '#FF8700',
    secondary: '#47C7FC',
    accent: '#FFFFFF',
    gradient: 'linear-gradient(165deg, #FF8700 0%, #F56600 35%, #D94F00 65%, #47C7FC 100%)',
    imageGradient: 'linear-gradient(to top, #FF8700 0%, rgba(255, 135, 0, 0.85) 25%, rgba(255, 135, 0, 0.4) 50%, transparent 100%)',
    sideGradient: 'linear-gradient(to right, rgba(255, 135, 0, 0.6) 0%, rgba(255, 135, 0, 0.3) 30%, transparent 60%)',
    glowColor: 'rgba(255, 135, 0, 0.5)',
  },
  alpine: {
    primary: '#0090FF',
    secondary: '#FF87BC',
    accent: '#FFFFFF',
    gradient: 'linear-gradient(165deg, #0090FF 0%, #0072CC 35%, #005599 65%, #FF87BC 100%)',
    imageGradient: 'linear-gradient(to top, #0090FF 0%, rgba(0, 144, 255, 0.85) 25%, rgba(0, 144, 255, 0.4) 50%, transparent 100%)',
    sideGradient: 'linear-gradient(to right, rgba(0, 144, 255, 0.6) 0%, rgba(0, 144, 255, 0.3) 30%, transparent 60%)',
    glowColor: 'rgba(0, 144, 255, 0.5)',
  },
};

export type TeamKey = keyof typeof teamGradients;

export function getTeamGradient(team: TeamKey) {
  return teamGradients[team];
}