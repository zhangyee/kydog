import type { CSSProperties } from 'react';

type Props = {
  size?: number;
  color?: string;
  style?: CSSProperties;
  className?: string;
  /** 暂停动画（用于在低噪场景静态展示） */
  still?: boolean;
};

export function KyMascot({ size = 28, color, style, className, still = false }: Props) {
  const ink = color ?? 'currentColor';
  return (
    <svg
      width={size}
      height={size}
      viewBox="20 -8 138 138"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <style>{`
        .ky-mascot .ear-tip-left,
        .ky-mascot .ear-tip-right,
        .ky-mascot .eye-circle,
        .ky-mascot .eye-x-line,
        .ky-mascot .tongue {
          transform-box: view-box;
        }
        .ky-mascot .ear-tip-left {
          transform-origin: 61.97px 29.8px;
          animation: ky-mascot-ear-left 10s ease-in-out infinite;
        }
        .ky-mascot .ear-tip-right {
          transform-origin: 106.485px 29.413px;
          animation: ky-mascot-ear-right 10s ease-in-out infinite;
        }
        .ky-mascot .eye-circle {
          transform-origin: 104.53px 75.302px;
          opacity: 0;
          transform: scale(0);
          animation: ky-mascot-eye-circle 10s ease-in-out infinite;
        }
        .ky-mascot .eye-x-line {
          stroke-dasharray: 1;
          stroke-dashoffset: 0;
          animation: ky-mascot-eye-x 10s ease-in-out infinite;
        }
        .ky-mascot .tongue {
          transform-origin: 84.66px 100.75px;
          animation: ky-mascot-tongue 10s ease-in-out infinite;
        }
        .ky-mascot.is-still .ear-tip-left,
        .ky-mascot.is-still .ear-tip-right,
        .ky-mascot.is-still .eye-circle,
        .ky-mascot.is-still .eye-x-line,
        .ky-mascot.is-still .tongue {
          animation: none;
        }

        /* 时间线（10s 循环，rest 在 0%–58% 与 94%–100%）:
             58%→65%  舌头收回 (scaleY 1→0)，末段与"开眼"重叠
             65%→70%  X 收回外角 + 圆眼淡入（开眼）
             72%→78%  左耳 perk 上→停→回（0→90→0）
             75%→81%  右耳 perk 上→停→回（0→-90→0）  —— 错开 0.3s
             78%→82%  圆眼收缩消失
             82%→90%  X 从外角生长回中心（闭眼完成）
             87%→94%  舌头吐出 (scaleY 0→1)，起段与 X regrow 末尾重叠 */
        @keyframes ky-mascot-tongue {
          0%, 61% { transform: scaleY(1); }
          65%, 88% { transform: scaleY(0); }
          92%, 100% { transform: scaleY(1); }
        }
        @keyframes ky-mascot-ear-left {
          0%, 72% { transform: rotate(0deg); }
          74%, 76% { transform: rotate(90deg); }
          78%, 100% { transform: rotate(0deg); }
        }
        @keyframes ky-mascot-ear-right {
          0%, 75% { transform: rotate(0deg); }
          77%, 79% { transform: rotate(-90deg); }
          81%, 100% { transform: rotate(0deg); }
        }
        @keyframes ky-mascot-eye-x {
          0%, 65% { stroke-dashoffset: 0; }
          70%, 82% { stroke-dashoffset: 1; }
          90%, 100% { stroke-dashoffset: 0; }
        }
        @keyframes ky-mascot-eye-circle {
          0%, 65% { opacity: 0; transform: scale(0); }
          70%, 78% { opacity: 1; transform: scale(1); }
          82%, 100% { opacity: 0; transform: scale(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .ky-mascot .ear-tip-left,
          .ky-mascot .ear-tip-right,
          .ky-mascot .eye-circle,
          .ky-mascot .eye-x-line,
          .ky-mascot .tongue {
            animation: none;
          }
        }
      `}</style>
      <g className={`ky-mascot${still ? ' is-still' : ''}`} fill="none" stroke={ink}>
        {/* 面部矩形 */}
        <rect
          x="35.166668"
          y="44.166668"
          width="99"
          height="81"
          rx="5"
          strokeWidth="3"
          strokeLinecap="round"
        />

        {/* 左眼（静态黑圆） */}
        <ellipse
          cx="63.107735"
          cy="75.301933"
          rx="7.1881261"
          ry="6.7904038"
          fill={ink}
          stroke="none"
        />

        {/* 右眼 · 开眼态（黑圆，动画里短暂显形） */}
        <ellipse
          className="eye-circle"
          cx="104.53"
          cy="75.301933"
          rx="7.1881261"
          ry="6.7904038"
          fill={ink}
          stroke="none"
        />

        {/* 右眼 · 闭眼态（X = 4 段，外角→中心，stroke-dashoffset 控制生长） */}
        <line
          className="eye-x-line"
          x1="99.486"
          y1="69.319"
          x2="104.53"
          y2="74.886"
          strokeWidth="3"
          strokeLinecap="round"
          pathLength="1"
        />
        <line
          className="eye-x-line"
          x1="109.58"
          y1="69.319"
          x2="104.53"
          y2="74.886"
          strokeWidth="3"
          strokeLinecap="round"
          pathLength="1"
        />
        <line
          className="eye-x-line"
          x1="99.486"
          y1="80.451"
          x2="104.53"
          y2="74.886"
          strokeWidth="3"
          strokeLinecap="round"
          pathLength="1"
        />
        <line
          className="eye-x-line"
          x1="109.58"
          y1="80.451"
          x2="104.53"
          y2="74.886"
          strokeWidth="3"
          strokeLinecap="round"
          pathLength="1"
        />

        {/* 左耳：竖段（butt cap，避免戳入矩形）+ 横段（round cap，拐点外角自然圆润） */}
        <line
          x1="61.97"
          y1="43.454"
          x2="61.97"
          y2="29.803"
          strokeWidth="9"
        />
        <line
          className="ear-tip-left"
          x1="61.97"
          y1="29.803"
          x2="33.709"
          y2="29.924"
          strokeWidth="9"
          strokeLinecap="round"
        />

        {/* 右耳：竖段（butt cap）+ 横段（round cap） */}
        <line
          x1="106.485"
          y1="43.064"
          x2="106.485"
          y2="29.413"
          strokeWidth="9"
        />
        <line
          className="ear-tip-right"
          x1="106.485"
          y1="29.413"
          x2="134.746"
          y2="29.534"
          strokeWidth="9"
          strokeLinecap="round"
        />

        {/* 嘴部横线（静态） */}
        <line
          x1="72.449"
          y1="100.753"
          x2="96.884"
          y2="100.493"
          strokeWidth="5"
          strokeLinecap="round"
        />

        {/* 舌头（动画收/吐，绕嘴部中点 scaleY） */}
        <g className="tongue" stroke={ink}>
          <line
            x1="84.66"
            y1="101.793"
            x2="84.66"
            y2="110.891"
            strokeWidth="12"
          />
          <circle cx="84.673" cy="110.434" r="6" fill={ink} stroke="none" />
        </g>
      </g>
    </svg>
  );
}
