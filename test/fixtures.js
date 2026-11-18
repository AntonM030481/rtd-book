// Synthetic HTML based on observed structure. No RTD personal data.
export const dates = ['30/11/26', '01/12/26', '02/12/26', '03/12/26', '04/12/26', '05/12/26'];
export const times = ['7:45', '8:30', '9:30', '10:15', '11:30', '12:15', '13:00', '13:45', '14:30', '16:00', '16:45', '17:30'];
export function calendar({ backgrounds = {}, headers = dates, omit = null } = {}) {
  return `<html><head><title>Popup Calendar</title></head><body>
    <form name="vrmSearch" action="../../ExaminerDateServlet" method="post">
    <input name="asd" value="04/12/2026"><input name="h_centre" value="1" type="hidden">
    <table><tr><td><table>
      <tr><td>Legend <img src="samplegreen.gif"></td>${headers.map(date => `<td><b>Weekday</b><br>${date}</td>`).join('')}</tr>
      ${times.map((time, row) => `<tr>${headers.map((date, col) => {
        if (omit === `${row}:${col}`) return '';
        const background = backgrounds[`${row}:${col}`] || 'redtime.gif';
        return `<td background="/WebPhase1/images/drivercalendar/${background}"><h5>${background === 'greentime.gif' ? `<a href="next.jsp">${time}</a>` : time}</h5></td>`;
      }).join('')}</tr>`).join('')}
    </table></td></tr></table></form></body></html>`;
}
