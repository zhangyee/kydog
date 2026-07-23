export type OnboardingLocale = 'zh' | 'en';

const zh = {
  welcome: '欢迎使用 KyDog',
  stepLanguage: '语言', stepNames: '称呼', stepModel: '模型与提供商', stepLook: '外观', stepDone: '完成',
  // 右栏各步大标题（问题式措辞，区别于左栏 rail 的短标签）
  stepTitleLanguage: '选择你的语言',
  stepTitleNames: '怎么称呼彼此？',
  stepTitleModel: '连接你的模型',
  stepTitleLook: '挑个顺眼的样子',
  stepTitleDone: '一切就绪',
  next: '下一步', back: '上一步', skip: '跳过',
  namesUserLabel: '怎么称呼你？', namesUserPlaceholder: 'You',
  namesAgentLabel: '怎么称呼你的助手？', namesAgentPlaceholder: 'KyDog',
  namesHint: '随时可以在工作区文件里改',
  modelHint: '选择提供商并设置默认模型（必需）',
  modelNotReady: '还没有默认模型——配置完成后才能继续',
  lookTheme: '主题', lookSize: '阅读字号',
  lookHint: '之后在用户菜单里也能调',
  sizeSmall: '小', sizeMedium: '中', sizeLarge: '大',
  doneSummary: (user: string, agent: string) => `${agent} 将称呼你为「${user}」。工作区文件会写入 ~/.kydog/。`,
  finish: '进入 KyDog', retry: '重试',
  recoveryTitle: '继续上次未完成的设置',
  recoveryBody: '上次设置中断了，将按原选择补齐工作区文件。',
  corruptNotice: '上次的设置记录已损坏并弃置（.bad 留证），请重新设置。',
  errInvalidInput: '输入不合法，请返回检查称呼等设置。',
  errModelMissing: '尚未配置默认模型，请返回第三步完成配置。',
  errSeedFailed: '写入工作区文件失败，请重试。详情见日志。',
} as const;

type OnboardingDict = {
  readonly [K in keyof typeof zh]: (typeof zh)[K] extends (...args: infer A) => infer R
    ? (...args: A) => R
    : string;
};

const en: OnboardingDict = {
  welcome: 'Welcome to KyDog',
  stepLanguage: 'Language', stepNames: 'Names', stepModel: 'Model & Provider', stepLook: 'Appearance', stepDone: 'Done',
  stepTitleLanguage: 'Choose your language',
  stepTitleNames: 'What should we call each other?',
  stepTitleModel: 'Connect your model',
  stepTitleLook: 'Pick a look you like',
  stepTitleDone: 'All set',
  next: 'Next', back: 'Back', skip: 'Skip',
  namesUserLabel: 'What should we call you?', namesUserPlaceholder: 'You',
  namesAgentLabel: 'What should we call your agent?', namesAgentPlaceholder: 'KyDog',
  namesHint: 'You can change this anytime in your workspace files',
  modelHint: 'Pick a provider and set a default model (required)',
  modelNotReady: 'No default model yet — finish configuration to continue',
  lookTheme: 'Theme', lookSize: 'Reading font size',
  lookHint: 'You can also adjust this later from the user menu',
  sizeSmall: 'Small', sizeMedium: 'Medium', sizeLarge: 'Large',
  doneSummary: (user: string, agent: string) => `${agent} will address you as "${user}". Workspace files go to ~/.kydog/.`,
  finish: 'Enter KyDog', retry: 'Retry',
  recoveryTitle: 'Resume incomplete setup',
  recoveryBody: 'Setup was interrupted. Your previous choices will be applied.',
  corruptNotice: 'The previous setup record was corrupt and set aside (.bad). Please set up again.',
  errInvalidInput: 'Invalid input — go back and check the names.',
  errModelMissing: 'No default model configured — go back to step 3.',
  errSeedFailed: 'Failed to write workspace files. Retry (see logs for details).',
};

export const onboardingDict: { zh: OnboardingDict; en: OnboardingDict } = { zh, en };
