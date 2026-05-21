interface Ad {
  title: string;
  text: string;
  image: string;
  buttonLabel: string;
  buttonUrl: string;
}

const ADS: Ad[] = [
  {
    title: "🌸 Biblioteca Anime Premium",
    text: "Acesse milhares de animes sensuais sem censura. Experimente grátis por 7 dias!",
    image: "https://image.pollinations.ai/prompt/anime%20advertisement%20banner%20beautiful%20girl%20purple%20theme?width=800&height=400&seed=1&nologo=true&model=flux",
    buttonLabel: "🎌 Ver Biblioteca",
    buttonUrl: "https://t.me/DoramaAI_Bot",
  },
  {
    title: "💎 Coleção Exclusiva VIP",
    text: "Doramas premium com narração sensual em HD. Conteúdo adulto exclusivo para assinantes.",
    image: "https://image.pollinations.ai/prompt/luxury%20anime%20advertisement%20elegant%20woman%20gold%20theme?width=800&height=400&seed=2&nologo=true&model=flux",
    buttonLabel: "👑 Quero VIP",
    buttonUrl: "https://t.me/DoramaAI_Bot",
  },
  {
    title: "🎭 Personagens IA Exclusivos",
    text: "Conheça dezenas de personagens anime criadas por IA. Narração personalizada.",
    image: "https://image.pollinations.ai/prompt/anime%20characters%20advertisement%20colorful%20vibrant%20theme?width=800&height=400&seed=3&nologo=true&model=flux",
    buttonLabel: "🌟 Conhecer",
    buttonUrl: "https://t.me/DoramaAI_Bot",
  },
];

let adIndex = 0;

export function getNextAd(): Ad {
  const ad = ADS[adIndex % ADS.length]!;
  adIndex++;
  return ad;
}

export function getRandomAd(): Ad {
  return ADS[Math.floor(Math.random() * ADS.length)]!;
}
