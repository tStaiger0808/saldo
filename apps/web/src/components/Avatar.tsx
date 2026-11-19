import { useEffect, useRef, useState } from "react";

/**
 * A person's picture, or their initial when there is none or it does not load. `decorative` where the name is printed
 * beside it; otherwise the name is its text alternative.
 */
export function Avatar({
  name,
  src,
  decorative = false,
  className = "avatar",
}: {
  name: string;
  src: string | null | undefined;
  decorative?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const picture = src && failed !== src ? src : null;

  // A picture that failed while the server-rendered page loaded did so before React listened for errors.
  useEffect(() => {
    const element = img.current;
    if (picture && element?.complete && element.naturalWidth === 0) setFailed(picture);
  }, [picture]);

  const initial = name.trim().charAt(0).toUpperCase() || "?";
  if (decorative) {
    return (
      <span className={className} aria-hidden="true">
        {picture ? <img ref={img} src={picture} alt="" onError={() => setFailed(picture)} /> : initial}
      </span>
    );
  }
  return picture ? (
    <span className={className}>
      <img ref={img} src={picture} alt={name} onError={() => setFailed(picture)} />
    </span>
  ) : (
    <span className={className} role="img" aria-label={name}>
      {initial}
    </span>
  );
}
