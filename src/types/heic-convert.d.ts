declare module "heic-convert" {
  interface ConvertOptions {
    buffer: Buffer | Uint8Array;
    format: "JPEG" | "PNG";
    quality?: number; // 0 to 1, only for JPEG
  }

  interface Image {
    convert(): Promise<Buffer>;
  }

  function convert(options: ConvertOptions): Promise<Buffer>;

  export default convert;
  export function all(options: ConvertOptions): Promise<Image[]>;
}
