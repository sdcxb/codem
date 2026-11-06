(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  var sections = links.map(function (a) {
    var id = a.getAttribute('href');
    return id ? document.querySelector(id) : null;
  }).filter(Boolean);
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      links.forEach(function (a) {
        a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id);
      });
    });
  }, { rootMargin: '-18% 0px -68% 0px', threshold: 0 });
  sections.forEach(function (s) { io.observe(s); });
})();
