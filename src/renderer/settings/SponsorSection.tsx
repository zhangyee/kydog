// 图片走 vite 的资源导入：产出带哈希的 ./assets/sponsor-<hash>.jpg，
// renderer 打包后是 loadFile 起的 file://，相对路径才解析得到。
import sponsorQr from '../assets/sponsor.jpg';

export function SponsorSection() {
  return (
    <div style={{ padding: '28px 28px 40px', maxWidth: 720 }}>
      <div
        className="font-serif"
        style={{ fontSize: 13.5, lineHeight: 1.75, color: 'var(--color-ink)' }}
      >
        KyDog 是一个人在维护的开源项目。如果它对你的科研工作有用，欢迎赞助。
      </div>

      <div style={{ marginTop: 22 }}>
        <img
          src={sponsorQr}
          alt="微信赞赏码"
          data-testid="sponsor-qr"
          width={260}
          height={260}
          style={{
            display: 'block',
            width: 260, height: 260,
            border: '0.5px solid var(--color-ink-hair-soft)',
            borderRadius: 2,
          }}
        />
        <div
          className="font-mono uppercase"
          style={{ marginTop: 10, fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 1.4 }}
        >
          微信扫码
        </div>
      </div>
    </div>
  );
}
