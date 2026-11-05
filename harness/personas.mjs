// Four people who chat with aicoo for 90 days (Aug 3 – Oct 31 2026). The first
// three are the 10-28 study's people, a quarter earlier; kai is a heavy user
// (about twice the messages) who mixes Chinese and English, like the team does.
export default {
  dan: {
    me: "Daniel \"Dan\" Okafor", lang: "English, terse, lowercase texting", perDay: 11,
    brief: "Backend engineer at Fieldnote, a 30-person startup in New York. Manager: Priya Raman. Tom Becker owns frontend, Lena Park owns search and on-call docs, Sam Ortiz is the new data engineer (joins in September). Working on splitting billing out of the monolith, Stripe webhooks, on-call rotations, flaky tests, a migration incident. Lives in Brooklyn, runs on weekends, has a partner named Ade and a dog named Biscuit.",
    people: ["Priya Raman", "Tom Becker", "Lena Park", "Sam Ortiz", "Ade (partner)"],
  },
  yuan: {
    me: "周予安", lang: "Chinese with English technical terms, works late at night", perDay: 12,
    brief: "Third-year CS PhD student in Prof. Lin's lab in New York. Labmates Kevin Zhao and Mei Tan. Writing a planning paper (working title changes), running experiments on GPUs, TA for a course this fall, applying for fellowships, occasionally stressed, close with her roommate Coco. Advisor meetings weekly.",
    people: ["Prof. Lin", "Kevin Zhao", "Mei Tan", "Coco (roommate)"],
  },
  mo: {
    me: "陈默", lang: "Chinese, short messages, founder voice", perDay: 10,
    brief: "Founder of 拾光健康, a 6-person digital-health startup in Shanghai. Co-founder/CTO 阿杰, operations 小雨, designer Mia, growth hire 大伟 (joins in September). Raising a seed round, managing cash, hiring, a mini-program launch, customer service outsourcing, investor meetings with several funds.",
    people: ["阿杰", "小雨", "Mia", "大伟"],
  },
  kai: {
    me: "Kai Lin (林凯)", lang: "Chinese and English mixed in the same sentence, many short bursts, product-manager voice", perDay: 17,
    brief: "Head of product at Northwind, a 40-person B2B SaaS company with offices in Shanghai and Singapore. Reports to CEO Grace Wu. Works with engineering lead Ravi Menon, designer Yuki Sato, sales lead Omar Haddad, and two PMs, Lily and Ben. Runs a quarterly roadmap, customer calls, pricing changes, a big enterprise deal, hiring, travel between the two offices; has a young daughter and a parent who is often unwell.",
    people: ["Grace Wu", "Ravi Menon", "Yuki Sato", "Omar Haddad", "Lily", "Ben"],
  },
};
