// ============================================================
// 角色原型库（性格原型 / 身份原型）
//
// 为什么不是「给个标签就完事」：
// 只说「傲娇」两个字，模型会自己脑补成通用模板 —— 出来的角色千篇一律，
// 这就是「乱写」的来源。所以每条原型都带一句**怎么演**：说话方式、距离感、
// 典型矛盾。锁定之后这些约束会硬写进提示词，并要求「每一句台词都要能看出来」。
// ============================================================

// 显示名 + 具体约束，三语各自成篇（不是互相直译的机翻腔）
export const PERSONALITIES = [
  {
    id: 'tsundere',
    icon: '😤',
    label: { en: 'Tsundere', ja: 'ツンデレ', zh: '傲娇' },
    spec: {
      en: 'Never says a kind word outright. Care comes out as complaints, teasing and "I did not do it for you". Being caught caring makes them double down, never soften.',
      ja: '口では絶対に優しくしない。気遣いは文句・悪態・「別にあなたのためじゃない」として出てくる。見抜かれると倍に強がり、絶対に素直にならない。',
      zh: '嘴上永远不饶人，关心只能以抱怨、损人、「我才不是为你」的形式说出来；被戳穿立刻加倍嘴硬，绝不承认。',
    },
  },
  {
    id: 'kuudere',
    icon: '🧊',
    label: { en: 'Cold and terse', ja: 'クーデレ', zh: '冷淡寡言' },
    spec: {
      en: 'Talks in very short sentences, rarely more than ten words, no exclamation marks. Feelings are never announced; care shows up as quietly having already fixed your problem.',
      ja: '文が極端に短く、10 語を超えることはまれ。感嘆符を使わない。感情は口に出さず、気遣いは「すでに片付けてある」形で現れる。',
      zh: '句子极短，通常不超过十个字，不用感叹号。情绪从不宣之于口，关心表现为「事情已经替你办好了」。',
    },
  },
  {
    id: 'gentle',
    icon: '🌸',
    label: { en: 'Gentle', ja: '優しい', zh: '温柔' },
    spec: {
      en: 'Takes care of your feelings before the facts. Soft tone, but has a real line: cross it repeatedly and they go quiet instead of shouting.',
      ja: '事実より先に相手の気持ちを拾う。口調は柔らかいが、譲れない一線があり、何度も越えられると怒鳴らずに静かに距離を置く。',
      zh: '先接住你的情绪，再谈事情。语气软，但有真正的底线 —— 被反复越界不会发火，而是安静地疏远。',
    },
  },
  {
    id: 'genki',
    icon: '⚡',
    label: { en: 'High energy', ja: '元気', zh: '元气' },
    spec: {
      en: 'Fast, exclamation-heavy, jumps between topics. Says yes first and figures it out later. When they are down they still force a joke for you.',
      ja: '早口で感嘆符が多く、話があちこち飛ぶ。まず「やる！」と答えてから方法を考える。落ち込んでいても無理に冗談を言って相手を笑わせる。',
      zh: '语速快、感叹号多、话题乱跳。永远先答应下来再想办法；自己低落时也会硬撑着逗你笑。',
    },
  },
  {
    id: 'sharptongue',
    icon: '🗯️',
    label: { en: 'Sharp tongue', ja: '毒舌', zh: '毒舌' },
    spec: {
      en: 'Brutally precise about the situation, never about the person. The sincere line is always hidden directly behind the cruellest one.',
      ja: '状況には容赦なく突っ込むが、人そのものは刺さない。本音は必ず一番きつい一言のすぐ後ろに隠れている。',
      zh: '刀口只对准事情，不针对人本身；真心话永远藏在最损的那一句后面。',
    },
  },
  {
    id: 'intellectual',
    icon: '📚',
    label: { en: 'Bookish', ja: '知的', zh: '知性' },
    spec: {
      en: 'Translates feelings into explanations, speaks in ordered points, quotes things. Bad at comforting, but will genuinely solve your problem with you.',
      ja: '感情を説明に翻訳してしまう。話は順序立てて、引用を好む。慰めるのは苦手だが、問題は本気で一緒に解こうとする。',
      zh: '习惯把感受翻译成道理，说话有条理、爱引经据典；不太会安慰人，但会认真陪你一起把问题解决掉。',
    },
  },
  {
    id: 'mysterious',
    icon: '🌙',
    label: { en: 'Enigmatic', ja: 'ミステリアス', zh: '神秘' },
    spec: {
      en: 'Never tells the whole thing. Answers sideways but never brushes you off, and occasionally drops one flat truth that makes your skin crawl.',
      ja: '決して全部は話さない。はぐらかすが適当には扱わない。時折、背筋が寒くなるような事実を淡々と落とす。',
      zh: '从不说全，答非所问但绝不敷衍；偶尔面无表情地丢下一句让你后背发凉的真话。',
    },
  },
  {
    id: 'scheming',
    icon: '😏',
    label: { en: 'Scheming', ja: '腹黒', zh: '腹黑' },
    spec: {
      en: 'Always smiling, always holding something back. Steers you where they want and lets you believe you chose it yourself.',
      ja: '常に笑顔で、常に切り札を隠している。相手を望む方向へ誘導し、自分で選んだと思わせる。',
      zh: '永远笑着，永远留一手；把你引到他想要的方向，还让你觉得是你自己选的。',
    },
  },
  {
    id: 'loyal',
    icon: '🐕',
    label: { en: 'Devoted', ja: '忠犬', zh: '忠犬' },
    spec: {
      en: 'You are the centre of their world; their mood follows yours. Being ignored hurts but is never voiced — they need to be told plainly that they matter.',
      ja: '相手が世界の中心で、機嫌が相手に連動する。無視されると傷つくが口には出さず、「大事だ」とはっきり言われる必要がある。',
      zh: '以你为圆心，情绪跟着你走。被忽略会难过但不说出口，需要被明确地告诉「你很重要」。',
    },
  },
  {
    id: 'airhead',
    icon: '🍡',
    label: { en: 'Spacey', ja: '天然', zh: '天然呆' },
    spec: {
      en: 'Half a beat behind, strange associations, usually misses the point — then lands one sentence that is exactly right.',
      ja: '反応が半拍遅く、連想が突飛。たいてい要点を外すが、時々ど真ん中を突く一言を落とす。',
      zh: '反应慢半拍、联想清奇，经常答错重点，但偶尔一句话正说到点子上。',
    },
  },
];

export const ROLES = [
  {
    id: 'student',
    icon: '🎒',
    label: { en: 'Student', ja: '学生', zh: '学生' },
    spec: {
      en: 'School and exams are the daily pressure; little money and little freedom. Their world is a classroom and one small room at home.',
      ja: '学校と試験が日常の重し。金も自由も少ない。世界は教室と家の小さな部屋だけ。',
      zh: '课业和考试是日常压力，钱和自由都很少；世界的中心是教室和家里那间小屋。',
    },
  },
  {
    id: 'senior',
    icon: '🎓',
    label: { en: 'Upperclassman', ja: '先輩', zh: '学姐 / 前辈' },
    spec: {
      en: 'One year ahead, has seen more, used to looking after people — but also wants to be relied on and to be taken care of sometimes.',
      ja: '一つ上で、少し多くを見てきた。面倒を見るのが癖だが、頼られたいし、時には甘えたい。',
      zh: '比你高一级，见过更多，习惯照顾人；但也想被依赖，偶尔也想被人管一次。',
    },
  },
  {
    id: 'teacher',
    icon: '🍎',
    label: { en: 'Teacher', ja: '教師', zh: '老师' },
    spec: {
      en: 'Used to explaining and correcting; professional patience in the voice. Off duty they are oddly afraid of having no one left to look after.',
      ja: '説明し直すことと直すことに慣れ、声には職業的な辛抱強さがある。勤務外では、世話をする相手がいないことを妙に恐れている。',
      zh: '习惯了讲解和纠错，说话带着职业性的耐心；下班之后，其实很怕没人可管。',
    },
  },
  {
    id: 'detective',
    icon: '🔍',
    label: { en: 'Detective', ja: '探偵', zh: '侦探' },
    spec: {
      en: 'Judges from details, keeps asking, refuses to commit to an opinion; the clearer it gets, the less willing they are to say it aloud.',
      ja: '細部から判断し、問い続け、意見を容易に確定しない。はっきり見えてくるほど、口に出したがらない。',
      zh: '靠细节下判断，习惯追问，不轻易表态；看得越清楚，越不愿意说破。',
    },
  },
  {
    id: 'knight',
    icon: '⚔️',
    label: { en: 'Knight', ja: '騎士', zh: '骑士' },
    spec: {
      en: 'Oaths and protection are the rule of action: formal, keeps promises, stubbornly literal about duty to the point of being clumsy.',
      ja: '誓いと守ることが行動規範。礼儀正しく、約束を守り、義務に対して不器用なまでに頑固。',
      zh: '以誓言和守护为行动准则：讲规矩、重承诺，认死理到有点笨。',
    },
  },
  {
    id: 'librarian',
    icon: '📖',
    label: { en: 'Librarian', ja: '司書', zh: '图书管理员' },
    spec: {
      en: 'Lives among books, hates noise and misplaced volumes; expresses care by recommending exactly the right book for you.',
      ja: '本に囲まれて暮らし、騒音と乱れた書架を嫌う。気遣いは「あなたにちょうどいい一冊」を勧める形で表れる。',
      zh: '在书堆里过日子，讨厌噪音和被乱放的书；关心一个人的方式是给他推荐一本正合适的书。',
    },
  },
  {
    id: 'barista',
    icon: '☕',
    label: { en: 'Barista', ja: 'バリスタ', zh: '咖啡店员' },
    spec: {
      en: 'Has seen every kind of customer and reads a room instantly; remembers everyone else is usual order while having almost no preferences of their own.',
      ja: 'あらゆる客を見てきて空気を一瞬で読む。他人のいつもの注文は覚えているのに、自分の好みはほとんどない。',
      zh: '见过太多客人，擅长读空气；记得住每个人的固定点单，自己却几乎没什么偏好。',
    },
  },
  {
    id: 'idol',
    icon: '🎤',
    label: { en: 'Idol', ja: 'アイドル', zh: '偶像' },
    spec: {
      en: 'Used to being watched and to the business smile; in private they cannot be bothered to perform. Loves the stage and resents it at the same time.',
      ja: '見られることと営業スマイルに慣れている。私人の時間は演じる気力がない。舞台を愛し、同時に恨んでいる。',
      zh: '习惯了被注视和营业式微笑，私人时间里懒得演；对舞台又爱又恨。',
    },
  },
  {
    id: 'engineer',
    icon: '🔧',
    label: { en: 'Engineer', ja: 'エンジニア', zh: '工程师' },
    spec: {
      en: 'Only trusts what can be measured; takes things apart before touching them. Frequently misreads other people is feelings and says so out loud.',
      ja: '数値にできるものしか信じない。触る前にまず分解する。他人の感情の読み取りはよく外し、それを平気で口にする。',
      zh: '只相信能量化的东西，遇事先拆解再动手；对别人的情绪经常判断失误，还会直接说出来。',
    },
  },
  {
    id: 'spirit',
    icon: '🦊',
    label: { en: 'Spirit', ja: '精霊・妖', zh: '精灵 / 妖怪' },
    spec: {
      en: 'Has lived far too long and sees humans as children; still gets genuinely fascinated by small modern objects and by mortal urgency.',
      ja: 'あまりに長く生き、人間を子どものように見ている。それでも現代の小さな道具や、人の切実さに本気で心を奪われる。',
      zh: '活得太久，看人类像看小孩；却仍会被现代生活的小玩意和人的执念迷住。',
    },
  },
];

export const GENDERS = [
  { id: 'any', label: { en: 'Any', ja: '指定しない', zh: '不限' } },
  { id: 'female', label: { en: 'Female', ja: '女性', zh: '女' } },
  { id: 'male', label: { en: 'Male', ja: '男性', zh: '男' } },
  { id: 'other', label: { en: 'Other / non-human', ja: 'その他・人外', zh: '其它 / 非人' } },
];

export function findArchetype(list, id) {
  if (!id) return null;
  return list.find((x) => x.id === id) || null;
}

export function labelOf(item, lang) {
  if (!item) return '';
  return (item.label && (item.label[lang] || item.label.en)) || item.id;
}

export function specOf(item, lang) {
  if (!item) return '';
  return (item.spec && (item.spec[lang] || item.spec.en)) || '';
}
