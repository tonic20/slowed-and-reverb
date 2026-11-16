if (new URLSearchParams(location.search).get('pinned') === '1') {
  document.querySelector('#pin-guide').open = false;
  document.querySelector('#pin-heading').textContent = 'Already pinned · View pin instructions';
  document.querySelector('.onboard .lead').textContent =
    'Your record icon is pinned. Play the sample to try the extension on this tab.';
}
