export interface BaseStock {
  symbol: string;
  name: string;
  sector: string;
  isin?: string;
}

export interface StockDetails {
  price: number | null;
  marketCap: string | null;
  pe: number | null;
  valuation: string | null;
}

export interface NewsItem {
  title: string;
  date: string;
  url: string;
}

export interface StockRecord extends BaseStock, StockDetails {
  changePercent: number | null;
  news: NewsItem[];
  trending?: boolean;
}
