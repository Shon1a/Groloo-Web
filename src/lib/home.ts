/* Home layout config — the row order and the studio logo set, ported from
 * assets/js/app.js (HOME_ROWS / STUDIOS). */

export interface HomeRow {
  cat: string;
  key: string;   // i18n key for the row title
}

/* Which HOME_ROWS belong to the "Catalog Rows" add-on vs the "Streaming Services"
 * add-on — the two configurable blocks whose rows the config toggles govern. */
export const CATALOG_CATS = ['trending_movie', 'trending_tv', 'top_movie', 'top_tv', 'trending_anime', 'top_anime'];
export const PROVIDER_CATS = ['prov_netflix', 'prov_disney', 'prov_prime', 'prov_apple', 'prov_max', 'prov_paramount', 'prov_crunchyroll'];

export const HOME_ROWS: HomeRow[] = [
  { cat: 'trending_movie', key: 'sec.trending_movies' },
  { cat: 'trending_tv', key: 'sec.trending_shows' },
  { cat: 'top_movie', key: 'sec.top_movies' },
  { cat: 'top_tv', key: 'sec.top_shows' },
  { cat: 'trending_anime', key: 'sec.trending_anime' },
  { cat: 'top_anime', key: 'sec.top_anime' },
  { cat: 'prov_netflix', key: 'sec.netflix' },
  { cat: 'prov_disney', key: 'sec.disney' },
  { cat: 'prov_prime', key: 'sec.prime' },
  { cat: 'prov_apple', key: 'sec.apple' },
  { cat: 'prov_max', key: 'sec.max' },
  { cat: 'prov_paramount', key: 'sec.paramount' },
  { cat: 'prov_crunchyroll', key: 'sec.crunchyroll' },
];

export interface Studio {
  key: string;
  name: string;
  logo: string;
  scale: number;
}

/* Optical --logo-scale calibrated per TMDB w300 logo, matching the vanilla list. */
export const STUDIOS: Studio[] = [
  { key: 'marvel', name: 'Marvel Studios', logo: '/hUzeosd33nzE5MCNsZxCGEKTXaQ.png', scale: 1.02 },
  { key: 'dreamworks', name: 'DreamWorks', logo: '/3BPX5VGBov8SDqTV7wC1L1xShAS.png', scale: 0.93 },
  { key: 'pixar', name: 'Pixar', logo: '/1TjvGVDMYsj6JBxOAkUHpPEwLf7.png', scale: 1.02 },
  { key: 'warner', name: 'Warner Bros.', logo: '/zhD3hhtKB5qyv7ZeL4uLpNxgMVU.png', scale: 1.10 },
  { key: 'dc', name: 'DC', logo: '/4Y00XuSMuP1gimd0jP6JT57QbCI.png', scale: 1.10 },
  { key: 'sony', name: 'Sony Pictures', logo: '/xAb1o9HrSvKBo9mnXC8fJKDNu00.png', scale: 1.02 },
  { key: 'universal', name: 'Universal', logo: '/8lvHyhjr8oUKOOy2dKXoALWKdp0.png', scale: 0.88 },
  { key: 'disney', name: 'Disney', logo: '/wdrCwmRnLFJhEoH8GSfymY85KHT.png', scale: 0.97 },
  { key: 'fox', name: '20th Century FOX', logo: '/qZCc1lty5FzX30aOCVRBLzaVmcp.png', scale: 1.08 },
  { key: 'paramount', name: 'Paramount Pictures', logo: '/jay6WcMgagAklUt7i9Euwj1pzTF.png', scale: 1.07 },
];
