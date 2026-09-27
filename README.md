# レシート家計簿 Web版

Android版と同じ家計簿（Firebase）をブラウザで使うためのページです。iPhone・Android・パソコンのどれでも使えます。

## できること
- ログイン・招待コードで家計簿に参加
- 記録（今月の支出・収入・収支・予算の残り、明細の一覧・手入力・編集・削除）
- レシート撮影 → AI（Gemini）で読み取り → 確認して保存（Android版と同じ形式で保存）
- 集計（週・月・年、前期間比、カテゴリ別、予算、推移グラフ、支払い方法別、AIのふりかえり）
- 立替・精算、貯金目標、今月の予算の状況、招待コードの確認

予算・カテゴリ・固定費の設定、カード明細の取り込み、医療費の集計は Android版で行います。

## 設定のしかた（最初の1回）
1. Firebase にウェブアプリを追加し、表示された firebaseConfig を `js/config.js` に貼る
2. このフォルダの中身を GitHub の公開リポジトリにアップロードし、GitHub Pages を有効にする
3. Firebase Authentication の「承認済みドメイン」に `（GitHubのユーザー名）.github.io` を追加
4. （AIを使う場合）reCAPTCHA v3 のキーを作り、サイトキーを `js/config.js` に、シークレットキーを Firebase App Check に登録

`js/config.js` の Firebase の設定値は、Web アプリでは公開される前提の値です（家計簿のデータは Firestore のルールで家族だけに守られています）。

## テスト
`node --test test/`（計算ロジックが Android版と同じ結果になるかを確認）
