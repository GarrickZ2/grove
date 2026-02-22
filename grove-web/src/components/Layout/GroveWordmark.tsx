import { useId } from "react";

interface GroveWordmarkProps {
  height?: number;
  className?: string;
}

// Vectorized "GROVE" text from logo.svg (updated design)
// G and E have accent-colored detail pieces (lighter)
// Main shapes use theme gradient, accent pieces use a lighter variant
export function GroveWordmark({ height = 22, className }: GroveWordmarkProps) {
  const id = useId().replace(/:/g, "");
  const width = Math.round(height * 4.3);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="-122 -25 244 50"
      width={width}
      height={height}
      className={className}
    >
      <defs>
        <linearGradient id={`${id}-wg`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="var(--color-highlight)" />
          <stop offset="100%" stopColor="var(--color-accent)" />
        </linearGradient>
      </defs>

      <g fill={`url(#${id}-wg)`}>
        {/* G — main arc (new shape) */}
        <g transform="translate(-95.6954, 0.0706)">
          <path transform="translate(-100, -100)" d="M 98.9718 124.768 C 98.4924 124.7201 98.0597 124.6723 97.5802 124.5756 C 88.9875 123.184 81.5949 117.1352 78.4259 109.0224 C 75.258 100.8134 76.7463 91.2128 82.3146 84.3959 C 87.7394 77.7236 96.4279 74.267 104.9728 75.4672 C 112.6535 76.5234 119.3742 81.1796 123.214 87.8525 L 112.9416 92.893 C 110.3488 88.8124 105.6925 86.412 100.8439 86.6523 C 96.6681 86.8925 92.7794 89.1005 90.4269 92.5571 C 87.7394 96.541 87.4513 101.8217 89.6115 106.0942 C 91.4835 109.7905 94.9875 112.4306 98.9718 113.1987 L 98.9718 124.768 Z" />
        </g>
        {/* G — accent corner piece */}
        <g transform="translate(-84.6987, 8.613)">
          <polygon fill="var(--color-text-muted)" opacity="0.5" points="12.0249,10.6572 0.6479,10.6572 0.6479,-0.5762 -12.0249,-0.5762 -12.0249,-10.6572 12.0249,-10.6572" />
        </g>

        {/* R + O */}
        <g transform="translate(-17.4617, -0.3925)">
          <path transform="translate(-101.085, -98.2336)" d="M 123.9829 122.6079 L 92.0122 122.6079 L 92.0845 122.6797 L 79.0513 122.6797 L 70.2666 105.542 L 64.5781 105.542 L 64.5781 122.6797 L 53.2007 122.6797 L 53.2007 95.4614 L 74.1548 95.4614 C 77.7549 95.4614 80.2031 93.3731 80.2031 90.1328 C 80.2031 86.9649 77.8272 84.8042 74.1548 84.8042 L 53.2007 84.8042 L 53.2007 74.6514 L 75.667 74.6514 C 85.6758 74.6514 91.7964 81.2041 91.7964 90.1328 C 91.7964 98.6294 86.4678 103.2378 81.2832 104.3902 L 86.1079 112.5269 L 124.127 112.5269 C 131.5435 112.5269 137.52 106.3345 137.52 98.7017 C 137.52 91.2852 131.5435 85.3086 124.127 85.3086 C 116.7822 85.3086 110.7339 91.2852 110.7339 98.7017 C 110.7339 102.374 112.1021 105.6861 114.4063 108.2066 L 101.1572 108.2066 C 99.9331 105.2544 99.2847 102.0137 99.2847 98.6294 C 99.2847 84.9483 110.4458 73.7876 124.127 73.7876 C 137.8804 73.7876 148.9693 84.9482 148.9693 98.6294 C 148.9693 111.9507 137.8804 122.6079 124.1992 122.6079 L 123.9829 122.6079 Z" />
        </g>

        {/* V */}
        <g transform="translate(62.5642, 0.0755)">
          <polygon points="-6.3726,23.978 -24.9502,-23.978 -12.061,-23.978 0.0361,9.5049 12.061,-23.978 24.9502,-23.978 6.4448,23.978 -6.3726,23.978" />
        </g>

        {/* E — horizontal bar */}
        <g transform="translate(97.8474, 19.0130)">
          <polygon points="-17.1733,-5.0405 21.062,-5.0405 21.062,5.0405 -21.062,5.0405 -17.1733,-5.0405" />
        </g>

        {/* E — main body */}
        <g transform="translate(101.1236, 0.2913)">
          <polygon points="-13.2488,-5.0405 17.1375,-5.0405 17.1375,5.0405 -17.1375,5.0405 -13.2488,-5.0405" />
        </g>

        {/* E — top bar (accent, lighter) */}
        <g transform="translate(105.1201, -18.8622)">
          <polygon fill="var(--color-text-muted)" opacity="0.5" points="-9.9011,-5.0403 13.7893,-5.0403 13.7893,5.0403 -13.7893,5.0403 -9.9011,-5.0403" />
        </g>
      </g>
    </svg>
  );
}
