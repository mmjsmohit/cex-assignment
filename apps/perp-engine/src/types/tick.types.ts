interface bookTick {
  stream: string;
  data: {
    A: string; // Inside ask quantity
    B: string; // Inside bid quantity
    E: number; // Event time in microseconds
    T: number; // Engine timestamp in microseconds
    a: string; // Inside ask price
    b: string; // Inside bid price
    e: string; // Event type
    s: string; // Symbol (Market)
    u: string | number; // Update ID
  };
}

export type { bookTick };
