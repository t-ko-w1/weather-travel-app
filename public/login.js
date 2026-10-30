const error = new URLSearchParams(window.location.search).get('error');
if (error === 'login_failed') {
  const message = document.querySelector('#login-error');
  message.textContent = 'ログインを完了できませんでした。設定とGoogleアカウントを確認して、もう一度お試しください。';
  message.hidden = false;
}
